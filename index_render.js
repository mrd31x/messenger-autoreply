// index_render.js - Clean final version
// - CHUNK_SIZE = 3
// - Media template for videos/images
// - Per-user cooldown with one follow-up message

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// === CONFIG (via env vars) ===
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30); // default 30 days
const FOLLOW_UP_TEXT = process.env.FOLLOW_UP_TEXT ||
  "Thanks for the follow-up — we received your message and will get back to you as soon as we can.";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 3); // default 3
const PORT = process.env.PORT || 10000;

// === FILE PATHS ===
const MANIFEST_PATH = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_PATH = path.join(__dirname, "served_users.json");

// === LOAD MEDIA MANIFEST ===
let mediaUrls = [];
try {
  if (fs.existsSync(MANIFEST_PATH)) {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8").trim();
    if (raw) mediaUrls = JSON.parse(raw);
  }
  console.log(`✅ Loaded ${mediaUrls.length} media items`);
} catch (err) {
  console.error("❌ Failed to load cloudinary_manifest.json:", err.message);
}

// === LOAD MEMORY ===
let served = {};
try {
  if (fs.existsSync(MEMORY_PATH)) {
    const raw = fs.readFileSync(MEMORY_PATH, "utf8");
    const obj = JSON.parse(raw || "{}");
    // normalize shape: { psid: { last: <ms>, followUp: <bool> } }
    Object.entries(obj).forEach(([k, v]) => {
      if (typeof v === "number") served[k] = { last: v, followUp: false };
      else if (v && typeof v.last === "number") served[k] = { last: v.last, followUp: !!v.followUp };
      else served[k] = { last: 0, followUp: false };
    });
  }
} catch (err) {
  console.error("❌ Failed to load served_users.json:", err.message);
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(served, null, 2));
  } catch (err) {
    console.error("❌ Failed to save served_users.json:", err.message);
  }
}

// dedupe message IDs
const seenMids = new Set();

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

// Build and send a media template chunk (images + videos)
async function sendChunk(psid, urls) {
  const elements = urls.map((url) => {
    const isVideo = /\/video\/|\.mp4|\.mov|\.webm/i.test(url);
    return { media_type: isVideo ? "video" : "image", url };
  });

  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "media",
          elements
        }
      }
    }
  };

  try {
    await fbSend(payload);
    console.log(`✅ Sent media template (${urls.length}) to ${psid}`);
    return;
  } catch (err) {
    console.error("❌ Media template error:", err.response?.data || err.message);
  }

  // Fallback: send each item individually
  for (const url of urls) {
    try {
      const isVideo = /\/video\/|\.mp4|\.mov|\.webm/i.test(url);
      const single = {
        recipient: { id: psid },
        message: {
          attachment: {
            type: isVideo ? "video" : "image",
            payload: { url }
          }
        }
      };
      await fbSend(single);
      console.log(`✅ Sent single ${isVideo ? "video" : "image"} to ${psid}`);
      await new Promise(r => setTimeout(r, 700));
    } catch (e) {
      console.error("❌ single media send error:", e.response?.data || e.message);
    }
  }
}

async function sendAllMedia(psid) {
  if (!mediaUrls || mediaUrls.length === 0) return;
  const chunks = [];
  for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE) {
    chunks.push(mediaUrls.slice(i, i + CHUNK_SIZE));
  }
  for (const chunk of chunks) {
    await sendChunk(psid, chunk);
    // pause between chunks to reduce rate pressure
    await new Promise(r => setTimeout(r, 800));
  }
}

// === WEBHOOK Verification ===
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// === MAIN WEBHOOK handler ===
app.post("/webhook", async (req, res) => {
  // quick response to FB
  res.sendStatus(200);

  if (req.body.object !== "page") return;

  for (const entry of req.body.entry || []) {
    for (const ev of entry.messaging || []) {
      const psid = ev.sender?.id;
      const mid = ev.message?.mid;
      if (!psid) continue;

      // dedupe
      if (mid && seenMids.has(mid)) continue;
      if (mid) seenMids.add(mid);

      // ignore echo or non-message
      if (!ev.message || ev.message.is_echo) continue;

      console.log("💬 Incoming message from:", psid);

      const now = Date.now();
      const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      const record = served[psid] || { last: 0, followUp: false };

      if (now - record.last < cooldownMs) {
        // still in cooldown
        if (!record.followUp) {
          // send the one-time follow-up
          await sendText(psid, FOLLOW_UP_TEXT);
          record.followUp = true;
          served[psid] = record;
          saveMemory();
          console.log(`ℹ️ Sent follow-up to ${psid}`);
        } else {
          console.log(`⏱ Still in cooldown for ${psid} — skipping`);
        }
        continue;
      }

      // Not in cooldown: deliver media + welcome text, reset followUp
      served[psid] = { last: now, followUp: false };
      saveMemory();

      await sendAllMedia(psid);

      await sendText(
        psid,
        "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
      );
    }
  }
});

// health route
app.get("/", (req, res) => res.send("✅ Messenger bot running"));

// start
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
