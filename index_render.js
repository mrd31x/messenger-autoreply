// index_render.js – Final Stable Anti-Flood Cloudinary Bot
// Author: ChatGPT configuration helper
// Environment vars: PAGE_ACCESS_TOKEN, VERIFY_TOKEN, ADMIN_IDS, COOLDOWN_DAYS, RESET_KEY, PORT

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// ========== CONFIG ==========
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_IDS = (process.env.ADMIN_IDS || "9873052959403429")
  .split(",")
  .map(s => s.trim());
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const RESET_KEY = process.env.RESET_KEY || "reset1531";
const PORT = process.env.PORT || 10000;

const MEMORY_FILE = path.join(__dirname, "served_users.json");
const CLOUDINARY_FILE = path.join(__dirname, "cloudinary_manifest.json");

// ========== MEMORY ==========
let servedUsers = {};
let lastMids = {};
let lastSent = {};

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      servedUsers = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    }
  } catch {
    servedUsers = {};
  }
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Failed to save memory:", e.message);
  }
}
loadMemory();

// ========== LOAD CLOUDINARY ==========
function loadCloudinaryManifest() {
  try {
    if (!fs.existsSync(CLOUDINARY_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(CLOUDINARY_FILE, "utf8"));
    return Array.isArray(arr) ? arr.filter(u => typeof u === "string" && u.startsWith("http")) : [];
  } catch (e) {
    console.error("Cloudinary load error:", e.message);
    return [];
  }
}

// ========== SEND HELPERS ==========
async function callSendAPI(payload) {
  const api = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(api, payload);
}
async function sendText(psid, text) {
  try {
    await callSendAPI({ recipient: { id: psid }, message: { text } });
  } catch (e) {
    console.error("sendText error:", e.response?.data || e.message);
  }
}
async function sendGalleryChunks(psid, mediaUrls) {
  const maxChunk = 6;
  for (let i = 0; i < mediaUrls.length; i += maxChunk) {
    const chunk = mediaUrls.slice(i, i + maxChunk);
    const elements = chunk.map(url => ({
      media_type: /\.mp4|\.mov|\.webm/i.test(url) ? "video" : "image",
      url,
    }));
    const payload = {
      recipient: { id: psid },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "media", elements },
        },
      },
    };
    try {
      await callSendAPI(payload);
      console.log(`✅ Sent media chunk (${chunk.length}) to ${psid}`);
    } catch (e) {
      console.error("Media send error:", e.response?.data || e.message);
    }
    await new Promise(r => setTimeout(r, 700));
  }
}

// ========== VERIFY WEBHOOK ==========
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ========== MAIN WEBHOOK ==========
app.post("/webhook", (req, res) => {
  // reply immediately to FB to prevent retries
  try { res.status(200).send("EVENT_RECEIVED"); } catch {}

  (async () => {
    if (!req.body || req.body.object !== "page") return;
    const mediaUrls = loadCloudinaryManifest();
    const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        if (event.message && event.message.is_echo) continue;
        const sender = event.sender && event.sender.id;
        if (!sender) continue;

        // dedupe by message.mid
        const mid = event.message && event.message.mid;
        if (mid && lastMids[sender] === mid) {
          console.log("Duplicate mid skip:", mid);
          continue;
        }
        if (mid) lastMids[sender] = mid;

        const isAdmin = ADMIN_IDS.includes(String(sender));
        const lastServed = servedUsers[sender] || 0;
        const withinCooldown = !isAdmin && lastServed && (now - lastServed < cooldownMs);

        // safety: 1-min window for repeated msgs
        const SAFETY_WINDOW_MS = 60 * 1000;
        const lastSentTs = lastSent[sender] || 0;

        if (withinCooldown) {
          if (now - lastSentTs > SAFETY_WINDOW_MS) {
            await sendText(sender, "Thanks — we received your message and will get back to you shortly.");
            lastSent[sender] = Date.now();
          }
          continue;
        }

        // mark served first
        servedUsers[sender] = Date.now();
        saveMemory();

        if (mediaUrls.length > 0) await sendGalleryChunks(sender, mediaUrls);

        if (now - lastSentTs > SAFETY_WINDOW_MS) {
          await sendText(
            sender,
            "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
          );
          lastSent[sender] = Date.now();
        }
      }
    }
  })();
});

// ========== ADMIN ROUTES ==========
app.get("/admin/reset", (req, res) => {
  const { psid, key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  if (!psid) return res.status(400).send("No PSID provided");
  delete servedUsers[psid];
  saveMemory();
  res.send(`✅ Cleared memory for ${psid}`);
});
app.get("/admin/reset-all", (req, res) => {
  const { key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  const count = Object.keys(servedUsers).length;
  servedUsers = {};
  saveMemory();
  res.send(`✅ All served users cleared (${count})`);
});

// ========== START ==========
app.get("/", (req, res) => res.send("Messenger bot running safely ✅"));
app.listen(PORT, () => console.log(`✅ Bot running on port ${PORT}`));
