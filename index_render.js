// index_render.js – Stable + 12-hour follow-up
// - CHUNK_SIZE = 3
// - video/image labeling fix
// - main media cooldown = 30 days
// - follow-up cooldown = 12 hours (send once every 12h during the 30-day window)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// === CONFIG (use env vars or keep as-is) ===
const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN ||
  "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77" ||
  "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const PORT = process.env.PORT || 10000;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 3); // 3 per chunk
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30); // main media cooldown
const FOLLOWUP_HOURS = Number(process.env.FOLLOWUP_HOURS || 12); // follow-up cooldown in hours

const WELCOME_TEXT =
  process.env.WELCOME_TEXT ||
  "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster.";
const SECONDARY_TEXT =
  process.env.SECONDARY_TEXT || "We will get back to you as soon as we can. Thank you.";

// === FILE PATHS ===
const MANIFEST_PATH = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_PATH = path.join(__dirname, "served_users.json");

// === LOAD MEDIA MANIFEST ===
let mediaUrls = [];
try {
  if (fs.existsSync(MANIFEST_PATH)) {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8").trim();
    mediaUrls = raw ? JSON.parse(raw) : [];
    console.log(`✅ Loaded ${mediaUrls.length} media files`);
  } else {
    console.log("⚠️ cloudinary_manifest.json not found");
  }
} catch (err) {
  console.error("❌ Failed to load cloudinary_manifest.json:", err.message);
}

// === LOAD MEMORY ===
let served = {};
try {
  if (fs.existsSync(MEMORY_PATH)) {
    const raw = fs.readFileSync(MEMORY_PATH, "utf8");
    served = raw ? JSON.parse(raw) : {};
    // normalize older entries if present
    for (const k of Object.keys(served)) {
      const v = served[k];
      if (typeof v === "number") {
        served[k] = { lastMedia: v, lastFollowup: 0 };
      } else {
        served[k].lastMedia = v.lastMedia || 0;
        served[k].lastFollowup = v.lastFollowup || 0;
      }
    }
  }
} catch (e) {
  console.warn("⚠️ Could not read served_users.json — starting fresh");
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(served, null, 2));
  } catch (e) {
    console.error("❌ Failed to save served_users.json:", e.message);
  }
}

// dedupe incoming message mids within process lifetime
const mids = new Set();

// === FACEBOOK helper ===
async function fbSend(payload) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN not set");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(url, payload);
}

async function sendText(psid, text) {
  try {
    await fbSend({ recipient: { id: psid }, message: { text } });
    console.log(`✅ Sent text to ${psid}`);
  } catch (err) {
    console.error("❌ sendText error:", err.response?.data || err.message);
  }
}

// send chunk — generic template with labels (Video vs Photo)
async function sendChunk(psid, urls) {
  const elements = urls.map((url, idx) => {
    const isVideo = /\/video\/|\.mp4|\.mov|\.webm/i.test(url);
    const label = isVideo ? `Video ${idx + 1}` : `Photo ${idx + 1}`;
    return {
      title: label,
      image_url: url,
      default_action: { type: "web_url", url }
    };
  });

  const payload = {
    recipient: { id: psid },
    message: { attachment: { type: "template", payload: { template_type: "generic", elements } } }
  };

  try {
    await fbSend(payload);
    console.log(`✅ Sent media chunk (${urls.length}) to ${psid}`);
  } catch (err) {
    console.error("❌ Media chunk error:", err.response?.data || err.message);
    // fallback: send individually with correct type
    for (const u of urls) {
      const isVideo = /\/video\/|\.mp4|\.mov|\.webm/i.test(u);
      const type = isVideo ? "video" : "image";
      try {
        await fbSend({
          recipient: { id: psid },
          message: { attachment: { type, payload: { url: u } } }
        });
        console.log(`✅ Sent single ${type} to ${psid}`);
      } catch (e) {
        console.error("❌ single media send error:", e.response?.data || e.message);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

async function sendAllMedia(psid) {
  if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) return;
  for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE) {
    const chunk = mediaUrls.slice(i, i + CHUNK_SIZE);
    await sendChunk(psid, chunk);
    await new Promise((r) => setTimeout(r, 800));
  }
}

// === WEBHOOKS ===
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // quick 200
  res.sendStatus(200);

  if (req.body.object !== "page") return;
  for (const entry of req.body.entry || []) {
    for (const ev of entry.messaging || []) {
      const psid = ev.sender?.id;
      const mid = ev.message?.mid;
      if (!psid) continue;
      if (mid && mids.has(mid)) continue;
      if (mid) mids.add(mid);

      if (!ev.message || ev.message.is_echo) continue;

      console.log("💬 Incoming from:", psid);

      // ensure record exists
      if (!served[psid]) served[psid] = { lastMedia: 0, lastFollowup: 0 };

      const now = Date.now();
      const mainCooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000; // 30 days
      const followupCooldownMs = FOLLOWUP_HOURS * 60 * 60 * 1000; // 12 hours

      const lastMedia = served[psid].lastMedia || 0;
      const lastFollowup = served[psid].lastFollowup || 0;

      // If 30 days passed since lastMedia (or first time)
      if (!lastMedia || now - lastMedia >= mainCooldownMs) {
        served[psid].lastMedia = now;
        served[psid].lastFollowup = now; // reset followup timestamp as well
        saveMemory();

        await sendAllMedia(psid);
        await sendText(psid, WELCOME_TEXT);
        console.log("✅ Media + welcome sent to", psid);
        continue;
      }

      // Else if 12 hours passed since last followup -> send secondary text once
      if (now - lastFollowup >= followupCooldownMs) {
        served[psid].lastFollowup = now;
        saveMemory();
        await sendText(psid, SECONDARY_TEXT);
        console.log("✅ Secondary follow-up sent to", psid);
        continue;
      }

      // Otherwise ignore
      console.log("⏱ In main cooldown and follow-up cooldown not yet passed for", psid);
    }
  }
});

// health
app.get("/", (req, res) => res.send("✅ Messenger bot running"));
app.listen(PORT, () => console.log(`🚀 Bot live on port ${PORT}`));
