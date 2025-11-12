// index_render.js – STABLE CLEAN VERSION (pre-flood)
// ✅ Cloudinary + welcome-last + 30-day memory + admin reset
// Port: 10000
// Admin PSID: 9873052959403429  |  Reset key: reset1531

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express().use(bodyParser.json());

// --- CONFIG ---
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_IDS = ["9873052959403429"];
const RESET_KEY = "reset1531";
const COOLDOWN_DAYS = 30;
const PORT = process.env.PORT || 10000;

const MEMORY_FILE = path.join(__dirname, "served_users.json");
const CLOUDINARY_FILE = path.join(__dirname, "cloudinary_manifest.json");

// --- MEMORY ---
let servedUsers = {};
try {
  if (fs.existsSync(MEMORY_FILE)) {
    servedUsers = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  }
} catch (e) {
  servedUsers = {};
}
function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
}

// --- CLOUDINARY MANIFEST ---
function loadCloudinaryManifest() {
  try {
    if (!fs.existsSync(CLOUDINARY_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(CLOUDINARY_FILE, "utf8"));
    return Array.isArray(arr) ? arr.filter(u => u.startsWith("http")) : [];
  } catch {
    return [];
  }
}

// --- MESSENGER HELPERS ---
async function callSendAPI(payload) {
  const api = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(api, payload);
}
async function sendText(psid, text) {
  try {
    await callSendAPI({ recipient: { id: psid }, message: { text } });
  } catch (e) {
    console.error("Text send error:", e.response?.data || e.message);
  }
}
async function sendMedia(psid, url) {
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: /\.mp4|\.mov|\.webm/i.test(url) ? "video" : "image",
        payload: { url },
      },
    },
  };
  try {
    await callSendAPI(payload);
  } catch (e) {
    console.error("Media send error:", e.response?.data || e.message);
  }
}

// --- VERIFY WEBHOOK ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// --- MAIN WEBHOOK ---
app.post("/webhook", async (req, res) => {
  try {
    if (req.body.object !== "page") return res.sendStatus(404);
    const mediaUrls = loadCloudinaryManifest();
    const cooldown = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.sender || !event.sender.id) continue;
        const sender = event.sender.id;

        // Skip echo
        if (event.message && event.message.is_echo) continue;

        const isAdmin = ADMIN_IDS.includes(String(sender));
        const lastServed = servedUsers[sender] || 0;
        const withinCooldown = !isAdmin && now - lastServed < cooldown;

        if (withinCooldown) {
          console.log("⏳ Skipping, user in cooldown:", sender);
          continue;
        }

        servedUsers[sender] = now;
        saveMemory();

        console.log(`📩 Serving new user: ${sender}`);

        // Send media sequentially (Facebook groups them visually)
        for (const url of mediaUrls) {
          await sendMedia(sender, url);
          await new Promise(r => setTimeout(r, 600));
        }

        // Send welcome message last
        await sendText(
          sender,
          "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
        );
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("Webhook error:", e.message);
    res.sendStatus(500);
  }
});

// --- ADMIN RESET ROUTES ---
app.get("/admin/reset", (req, res) => {
  const { psid, key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  if (!psid) return res.status(400).send("No psid provided");
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
  res.send(`✅ Cleared all users (${count})`);
});

// --- START SERVER ---
app.get("/", (req, res) => res.send("✅ Messenger bot is running"));
app.listen(PORT, () => console.log(`✅ Bot server running on port ${PORT}`));
