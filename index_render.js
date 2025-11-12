// index_render.js
// Cloudinary-only, chunked gallery, flood-proof, admin resets
// Admin PSID default: 9873052959403429
// RESET_KEY default: reset1531
// Port default: 10000

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

// Cloudinary manifest path (must be a JSON array of http(s) URLs)
const CLOUDINARY_FILE = path.join(__dirname, "cloudinary_manifest.json");

// Disable any local media directory — Cloudinary-only mode
const USE_LOCAL_MEDIA = false;

// Memory file for served users
const MEMORY_FILE = path.join(__dirname, "served_users.json");

// ---------- MEMORY & DEDUPE ----------
let servedUsers = {};   // servedUsers[psid] = timestampMillis
let lastMids = {};      // lastMids[psid] = last message.mid processed
let lastSent = {};      // lastSent[psid] = timestampMillis for safety window

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf8");
      servedUsers = raw ? JSON.parse(raw) : {};
    } else {
      servedUsers = {};
    }
  } catch (err) {
    console.error("Failed to load memory:", err);
    servedUsers = {};
  }
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save memory:", err);
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
    // filter and normalize
    return arr
      .filter(u => typeof u === "string" && /^https?:\/\//i.test(u))
      .map(u => u.trim());
  } catch (err) {
    console.error("Error loading cloudinary_manifest.json:", err);
    return [];
  }
}

// ---------- SEND HELPERS ----------
async function callSendAPI(payload) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN not set");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(url, payload);
}

async function sendText(psid, text) {
  const payload = { recipient: { id: psid }, message: { text } };
  try {
    await callSendAPI(payload);
  } catch (err) {
    console.error("sendText error:", err.response?.data || err.message);
  }
}

// chunked gallery sender (safe chunk size)
async function sendGalleryChunks(psid, mediaUrls) {
  if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) return;
  const maxChunk = 4; // conservative & safe
  for (let i = 0; i < mediaUrls.length; i += maxChunk) {
    const chunk = mediaUrls.slice(i, i + maxChunk);
    const elements = chunk.map(url => ({
      media_type: /\.mp4|\.mov|\.webm/i.test(url) ? "video" : "image",
      url
    }));

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
      await callSendAPI(payload);
      console.log(`✅ Sent media chunk (${chunk.length}) to ${psid}`);
    } catch (err) {
      console.error("Media send error:", err.response?.data || err.message);
      // continue to next chunk
    }

    // small delay between chunks
    await new Promise(r => setTimeout(r, 700));
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
  return res.sendStatus(403);
});

// ---------- MAIN WEBHOOK (fast ack + async processing) ----------
app.post("/webhook", (req, res) => {
  // Immediately acknowledge to stop FB retrying
  try { res.status(200).send("EVENT_RECEIVED"); } catch (e) { /* ignore */ }

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
            console.log("Duplicate mid, skipping:", mid);
            continue;
          }
          lastMids[sender] = mid;
        }

        console.log("Incoming message from:", sender);

        const isAdmin = ADMIN_IDS.includes(String(sender));
        const lastServed = servedUsers[sender] || 0;
        const withinCooldown = !isAdmin && lastServed && (now - lastServed < cooldownMs);

        // safety ack if within cooldown (but rate-limited)
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

        // mark served BEFORE sending to avoid duplicates on retry
        servedUsers[sender] = Date.now();
        saveMemory();

        // send gallery chunks (Cloudinary only)
        if (mediaUrls.length > 0) {
          await sendGalleryChunks(sender, mediaUrls);
        } else {
          console.log("No Cloudinary media found in manifest.");
        }

        // send final welcome (rate-limited)
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

// ---------- ADMIN ROUTES ----------
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
  console.log(`✅ Bot server is running on port ${PORT}`);
  const mediaCount = loadCloudinaryManifest().length;
  console.log(`✅ Loaded ${mediaCount} Cloudinary media items`);
  console.log(`Admin PSIDs: ${ADMIN_IDS.join(", ")}`);
});
