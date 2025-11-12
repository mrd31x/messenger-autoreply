// index_render.js
// Cloudinary-only, safe image chunks (image_url), videos as attachments,
// immediate 200, dedupe, mark-before-send, admin resets.

// imports
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// ---------- CONFIG ----------
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_IDS = (process.env.ADMIN_IDS || "9873052959403429")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const RESET_KEY = process.env.RESET_KEY || "reset1531";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const PORT = process.env.PORT || 10000;

const CLOUDINARY_FILE = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_FILE = path.join(__dirname, "served_users.json");

// ---------- MEMORY & DEDUPE ----------
let servedUsers = {}; // psid -> timestamp
let lastMids = {};    // psid -> last message.mid
let lastSent = {};    // psid -> timestamp for safety window

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf8");
      servedUsers = raw ? JSON.parse(raw) : {};
    } else {
      servedUsers = {};
    }
  } catch (err) {
    console.error("Failed to load memory:", err.message);
    servedUsers = {};
  }
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save memory:", err.message);
  }
}
loadMemory();

// ---------- CLOUDINARY LOADER ----------
function loadCloudinaryManifest() {
  try {
    if (!fs.existsSync(CLOUDINARY_FILE)) return [];
    const raw = fs.readFileSync(CLOUDINARY_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(u => typeof u === "string" && /^https?:\/\//i.test(u))
      .map(u => u.trim());
  } catch (err) {
    console.error("Error loading cloudinary_manifest.json:", err.message);
    return [];
  }
}

// ---------- MESSENGER HELPERS ----------
async function callSendAPI(payload) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN not set");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(url, payload);
}

async function sendText(psid, text) {
  try {
    await callSendAPI({ recipient: { id: psid }, message: { text } });
  } catch (err) {
    console.error("sendText error:", err.response?.data || err.message);
  }
}

// New: image chunks use image_url property; videos sent as attachments
async function sendMediaGallery(psid, mediaUrls) {
  if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) return;

  // split images and videos
  const images = mediaUrls.filter(u => !u.match(/\.(mp4|mov|webm)(\?.*)?$/i));
  const videos = mediaUrls.filter(u => u.match(/\.(mp4|mov|webm)(\?.*)?$/i));

  // send images in chunks using image_url (chunk size = 3)
  const IMG_CHUNK = 3;
  console.log(`Preparing to send ${images.length} images (chunks of ${IMG_CHUNK}) and ${videos.length} videos to ${psid}`);

  for (let i = 0; i < images.length; i += IMG_CHUNK) {
    const chunk = images.slice(i, i + IMG_CHUNK);
    const elements = chunk.map(url => ({ media_type: "image", image_url: url }));

    const payload = {
      recipient: { id: psid },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "media", elements }
        }
      }
    };

    try {
      console.log(`→ Sending image chunk (${chunk.length}) to ${psid}`);
      await callSendAPI(payload);
      console.log(`✅ Sent image chunk (${chunk.length}) to ${psid}`);
    } catch (err) {
      console.error("Image chunk send error:", err.response?.data || err.message);
      // continue to next chunk
    }

    // small pause between chunks
    await new Promise(r => setTimeout(r, 800));
  }

  // videos: send individually as video attachments
  for (const v of videos) {
    const payload = {
      recipient: { id: psid },
      message: {
        attachment: {
          type: "video",
          payload: { url: v, is_reusable: true }
        }
      }
    };
    try {
      console.log(`→ Sending video to ${psid}: ${v}`);
      await callSendAPI(payload);
      console.log(`✅ Sent video to ${psid}`);
    } catch (err) {
      console.error("Video send error:", err.response?.data || err.message);
      // continue
    }
    await new Promise(r => setTimeout(r, 900));
  }
}

// ---------- WEBHOOK VERIFICATION ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ---------- MAIN WEBHOOK (fast ACK + async processing) ----------
app.post("/webhook", (req, res) => {
  // Immediate response so FB won't retry
  try { res.status(200).send("EVENT_RECEIVED"); } catch (e) {}

  (async () => {
    if (!req.body || req.body.object !== "page") return;
    const mediaUrls = loadCloudinaryManifest();
    const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const SAFETY_WINDOW_MS = 60 * 1000; // 1 minute

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        // ignore echoes
        if (event.message && event.message.is_echo) continue;

        const sender = event.sender && event.sender.id;
        if (!sender) continue;

        // dedupe by message.mid
        const mid = event.message && event.message.mid;
        if (mid) {
          if (lastMids[sender] && lastMids[sender] === mid) {
            console.log("Duplicate mid skip:", mid);
            continue;
          }
          lastMids[sender] = mid;
        }

        console.log("Incoming message from:", sender);

        const isAdmin = ADMIN_IDS.includes(String(sender));
        const lastServed = servedUsers[sender] || 0;
        const withinCooldown = !isAdmin && lastServed && (now - lastServed < cooldownMs);

        // If within cooldown, send a short ack (rate-limited)
        if (withinCooldown) {
          const lastAck = lastSent[sender] || 0;
          if (now - lastAck > SAFETY_WINDOW_MS) {
            await sendText(sender, "Thanks — we received your message and will get back to you shortly.");
            lastSent[sender] = Date.now();
          } else {
            console.log("Ack suppressed by safety window for", sender);
          }
          continue;
        }

        // Mark served BEFORE sending to prevent duplicates on webhook retries
        servedUsers[sender] = Date.now();
        saveMemory();

        // Send media (images in safe chunks, videos as attachments)
        if (mediaUrls.length > 0) {
          await sendMediaGallery(sender, mediaUrls);
        } else {
          console.log("No Cloudinary media found in manifest.");
        }

        // Final welcome message (rate-limited)
        const lastAck2 = lastSent[sender] || 0;
        if (Date.now() - lastAck2 > SAFETY_WINDOW_MS) {
          await sendText(
            sender,
            "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
          );
          lastSent[sender] = Date.now();
        } else {
          console.log("Welcome suppressed by safety window for", sender);
        }
      }
    }
  })();
});

// ---------- ADMIN ENDPOINTS ----------
app.get("/admin/reset", (req, res) => {
  const { psid, key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  if (!psid) return res.status(400).send("No psid provided");
  delete servedUsers[psid];
  saveMemory();
  console.log(`Cleared memory for ${psid}`);
  res.send(`✅ Cleared memory for ${psid}`);
});

app.get("/admin/reset-all", (req, res) => {
  const { key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  const count = Object.keys(servedUsers).length;
  servedUsers = {};
  saveMemory();
  console.log(`Cleared ALL memory (${count})`);
  res.send(`✅ All served users cleared (${count})`);
});

// health
app.get("/", (req, res) => res.send("Messenger bot (Cloudinary-only) running"));

// start
app.listen(PORT, () => {
  console.log(`✅ Bot server running on port ${PORT}`);
  const mediaCount = loadCloudinaryManifest().length;
  console.log(`✅ Loaded ${mediaCount} Cloudinary media items`);
  console.log(`Admin PSIDs: ${ADMIN_IDS.join(", ")}`);
});
