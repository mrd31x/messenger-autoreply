// index_render.js – Stable v1.3 Messenger auto-reply
// - CHUNK_SIZE = 3
// - video/image labeling fix
// - cooldown + secondary reply behavior (only once during cooldown)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// === CONFIG (set these in Render env vars or edit here for local testing) ===
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "EAAQ2omfzFccBP1EqtZCGs..."; // replace or use env var
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30); // how long until media can be resent
const PORT = process.env.PORT || 10000;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 3);

const WELCOME_TEXT =
  process.env.WELCOME_TEXT ||
  "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster.";
const SECONDARY_TEXT =
  process.env.SECONDARY_TEXT ||
  "We will get back to you as soon as we can. Thank you.";

// === FILE PATHS ===
const MANIFEST_PATH = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_PATH = path.join(__dirname, "served_users.json");

// Load media URLs
let mediaUrls = [];
try {
  if (fs.existsSync(MANIFEST_PATH)) {
    mediaUrls = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    console.log(`✅ Loaded ${mediaUrls.length} media files`);
  } else {
    console.log("⚠️ cloudinary_manifest.json not found");
  }
} catch (e) {
  console.error("❌ Failed to read manifest:", e.message);
}

// Load/normalize memory (served users)
let served = {};
try {
  if (fs.existsSync(MEMORY_PATH)) {
    served = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
    // normalize old format where value might be a number timestamp
    for (const k of Object.keys(served)) {
      if (typeof served[k] === "number") {
        served[k] = { last: served[k], secondSent: false };
      } else {
        // ensure keys exist
        served[k].last = served[k].last || 0;
        served[k].secondSent = !!served[k].secondSent;
      }
    }
  }
} catch (e) {
  console.warn("⚠️ Could not read served_users.json — starting fresh");
}
const saveMemory = () =>
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(served, null, 2));

// Deduplicate incoming message IDs for the short lifespan of the process
const mids = new Set();

// === FACEBOOK SEND HELPER ===
async function fbSend(payload) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(url, payload);
}

async function sendText(psid, text) {
  try {
    await fbSend({ recipient: { id: psid }, message: { text } });
    console.log("✅ Sent text to", psid);
  } catch (e) {
    console.error("❌ sendText error:", e.response?.data || e.message);
  }
}

// Build template elements and label by type (video vs image)
async function sendChunk(psid, urls) {
  const elements = urls.map((url, i) => {
    const isVideo = /\/video\//i.test(url);
    const label = isVideo ? `Video ${i + 1}` : `Photo ${i + 1}`;
    // Generic template expects an image_url even for video preview — Messenger will show a preview.
    return {
      title: label,
      image_url: url,
      default_action: { type: "web_url", url }
    };
  });

  const msg = {
    recipient: { id: psid },
    message: {
      attachment: { type: "template", payload: { template_type: "generic", elements } }
    }
  };

  try {
    await fbSend(msg);
    console.log(`✅ Sent ${urls.length}-media chunk to ${psid}`);
  } catch (e) {
    console.error("❌ Image chunk error:", e.response?.data || e.message);
    // fallback: send individually using correct attachment type
    for (const u of urls) {
      const isVideo = /\/video\//i.test(u);
      const type = isVideo ? "video" : "image";
      try {
        await fbSend({
          recipient: { id: psid },
          message: { attachment: { type, payload: { url: u } } }
        });
        console.log(`✅ Sent single ${type} to ${psid}`);
      } catch (err) {
        console.error("❌ single media error:", err.response?.data || err.message);
      }
      // small pause to avoid rate issues
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

async function sendAllMedia(psid) {
  if (!mediaUrls || mediaUrls.length === 0) return;
  const chunks = [];
  for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE) {
    chunks.push(mediaUrls.slice(i, i + CHUNK_SIZE));
  }
  for (const c of chunks) {
    await sendChunk(psid, c);
    await new Promise(r => setTimeout(r, 800));
  }
}

// === WEBHOOK ENDPOINTS ===
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
  // Immediately acknowledge to Facebook
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

      const now = Date.now();
      const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

      // ensure served[psid] shape
      if (!served[psid]) served[psid] = { last: 0, secondSent: false };

      const last = served[psid].last || 0;
      const inCooldown = now - last < cooldownMs;

      if (!inCooldown) {
        // first contact (or cooldown expired): send media + welcome, reset secondSent
        served[psid] = { last: now, secondSent: false };
        saveMemory();

        await sendAllMedia(psid);
        await sendText(psid, WELCOME_TEXT);
        console.log("✅ Media + welcome sent to", psid);
      } else {
        // in cooldown: send secondary reply only once
        if (!served[psid].secondSent) {
          try {
            await sendText(psid, SECONDARY_TEXT);
            served[psid].secondSent = true;
            saveMemory();
            console.log("✅ Secondary reply sent to", psid);
          } catch (e) {
            console.error("❌ Secondary send error:", e.response?.data || e.message);
          }
        } else {
          console.log("⏱ Still in cooldown and secondary already sent - skipping for", psid);
        }
      }
    }
  }
});

// health-check
app.get("/", (req, res) => res.send("✅ Messenger bot running"));
app.listen(PORT, () => console.log(`🚀 Bot live on port ${PORT}`));
