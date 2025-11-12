// index_render.js – clean stable Messenger auto-reply (Render-ready, no admin code)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// === CONFIG (set these in Render env vars) ===
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const PORT = process.env.PORT || 10000;
const CHUNK_SIZE = 4; // number of media per carousel

// === DATA FILES ===
const MANIFEST_PATH = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_PATH = path.join(__dirname, "served_users.json");

// Load media URLs
let mediaUrls = [];
try {
  if (fs.existsSync(MANIFEST_PATH)) {
    mediaUrls = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    console.log(`✅ Loaded ${mediaUrls.length} media files`);
  } else console.log("⚠️ cloudinary_manifest.json not found");
} catch (e) {
  console.error("❌ Failed to read manifest:", e.message);
}

// Load memory (cooldown)
let served = {};
try {
  if (fs.existsSync(MEMORY_PATH))
    served = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
} catch {}
const saveMemory = () =>
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(served, null, 2));

// Dedup recently processed message IDs
const mids = new Set();

// === HELPERS ===
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

async function sendChunk(psid, urls) {
  const elements = urls.map((url, i) => ({
    title: `Photo ${i + 1}`,
    image_url: url,
    default_action: { type: "web_url", url }
  }));
  const msg = {
    recipient: { id: psid },
    message: {
      attachment: { type: "template", payload: { template_type: "generic", elements } }
    }
  };
  try {
    await fbSend(msg);
    console.log(`✅ Sent ${urls.length}-image chunk`);
  } catch (e) {
    console.error("❌ Image chunk error:", e.response?.data || e.message);
    // fallback to single-image sends
    for (const u of urls) {
      await fbSend({
        recipient: { id: psid },
        message: { attachment: { type: "image", payload: { url: u } } }
      }).catch(err =>
        console.error("❌ single image error:", err.response?.data || err.message)
      );
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

async function sendAllMedia(psid) {
  const chunks = [];
  for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE)
    chunks.push(mediaUrls.slice(i, i + CHUNK_SIZE));
  for (const c of chunks) {
    await sendChunk(psid, c);
    await new Promise(r => setTimeout(r, 800));
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
  res.sendStatus(200);
  if (req.body.object !== "page") return;

  for (const entry of req.body.entry || []) {
    for (const ev of entry.messaging || []) {
      const psid = ev.sender?.id;
      const mid = ev.message?.mid;
      if (!psid || mids.has(mid)) continue;
      mids.add(mid);

      if (!ev.message || ev.message.is_echo) continue;
      console.log("💬 Incoming from:", psid);

      const now = Date.now();
      const last = served[psid] || 0;
      const cooldown = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

      if (now - last < cooldown) {
        console.log("⏱ Still in cooldown, skipping media for", psid);
        continue;
      }

      served[psid] = now;
      saveMemory();

      await sendAllMedia(psid);
      await sendText(
        psid,
        "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
      );
    }
  }
});

// === HEALTH ===
app.get("/", (req, res) => res.send("✅ Messenger bot running"));

app.listen(PORT, () => console.log(`🚀 Bot live on port ${PORT}`));
