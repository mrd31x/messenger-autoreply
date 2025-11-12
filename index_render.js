/**
 * index_render.js
 * Clean Messenger auto-reply bot for Render
 *
 * Usage:
 *  - Set environment variables in Render dashboard (PAGE_ACCESS_TOKEN, VERIFY_TOKEN, ADMIN_IDS, COOLDOWN_DAYS, RESET_KEY, PUBLIC_URL)
 *  - Start command: node index_render.js
 *
 * Security:
 *  - RESET_KEY protects admin reset endpoints.
 *  - ADMIN_IDS is a comma-separated list of PSIDs that bypass cooldown (useful for admin testing).
 */

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// ---------- Config from environment ----------
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_IDS = (process.env.ADMIN_IDS || "9873052959403429") // default admin PSID you provided
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const RESET_KEY = process.env.RESET_KEY || "reset1531";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
const MEDIA_FOLDER = path.join(__dirname, "media");
const CLOUDINARY_MANIFEST = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_FILE = path.join(__dirname, "served_users.json");
const PORT = process.env.PORT || 3000;

// ---------- Serve local media folder at /media ----------
app.use("/media", express.static(MEDIA_FOLDER));

// ---------- Simple persistent memory (served users) ----------
let servedUsers = {};
function loadServedUsers() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf8");
      servedUsers = raw ? JSON.parse(raw) : {};
    } else {
      servedUsers = {};
    }
  } catch (err) {
    console.error("Failed to load served users:", err);
    servedUsers = {};
  }
}
function saveServedUsers() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save served users:", err);
  }
}
loadServedUsers();

// ---------- Helper: build media URLs ----------
function getLocalMediaUrls() {
  try {
    if (!fs.existsSync(MEDIA_FOLDER)) return [];
    const files = fs.readdirSync(MEDIA_FOLDER);
    // Only include typical media file extensions
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".mp4", ".mov", ".webm"];
    return files
      .filter(f => allowed.includes(path.extname(f).toLowerCase()))
      .map(f => `${PUBLIC_URL.replace(/\/$/, "")}/media/${encodeURIComponent(f)}`);
  } catch (err) {
    console.error("Error reading media folder:", err);
    return [];
  }
}

function getCloudinaryUrls() {
  try {
    if (!fs.existsSync(CLOUDINARY_MANIFEST)) return [];
    const raw = fs.readFileSync(CLOUDINARY_MANIFEST, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (err) {
    console.error("Error reading cloudinary manifest:", err);
    return [];
  }
}

// Decide preferred media source: if cloudinary_manifest exists, use it; otherwise local folder
function buildMediaList() {
  const cloud = getCloudinaryUrls();
  if (cloud.length) return cloud;
  return getLocalMediaUrls();
}

// ---------- Messenger webhook verification ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified!");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ---------- Send message helpers ----------
async function callSendAPI(payload) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  try {
    const resp = await axios.post(url, payload);
    return resp.data;
  } catch (err) {
    console.error("Call to Send API failed:", err.response?.data || err.message);
    throw err;
  }
}

async function sendText(senderId, text) {
  const payload = {
    recipient: { id: senderId },
    message: { text },
  };
  await callSendAPI(payload);
}

async function sendAttachmentByUrl(senderId, type, url) {
  // type: "image" | "video" | "audio" | "file"
  const messageData = {
    recipient: { id: senderId },
    message: {
      attachment: {
        type,
        payload: { url, is_reusable: true },
      },
    },
  };
  await callSendAPI(messageData);
}

// ---------- Main webhook receiver ----------
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  const mediaList = buildMediaList(); // array of URLs

  body.entry.forEach(async entry => {
    const messagingEvents = entry.messaging || [];
    for (const event of messagingEvents) {
      // ignore echoes
      if (event.message && event.message.is_echo) continue;

      const sender = event.sender && event.sender.id;
      if (!sender) continue;

      console.log("Incoming message from:", sender);

      // Admin bypass
      const isAdmin = ADMIN_IDS.includes(String(sender));
      const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

      const lastServed = servedUsers[sender] || 0;
      const now = Date.now();
      const withinCooldown = !isAdmin && lastServed && now - lastServed < cooldownMs;

      try {
        if (withinCooldown) {
          console.log(`User already served within cooldown, skipping media for: ${sender}`);
          // Send a short acknowledgment only
          await sendText(sender, "Thanks — we received your message and will get back to you shortly.");
        } else {
          // Send a brief text first (optional)
          await sendText(sender, "Hi! Thanks for messaging us — sending our latest photos and videos now...");

          // Send media one-by-one (image/video) sequentially to avoid rate issues
          for (const mediaUrl of mediaList) {
            // Determine type from extension
            const ext = path.extname(mediaUrl).toLowerCase();
            const type = ext.match(/mp4|mov|webm/) ? "video" : "image";
            try {
              await sendAttachmentByUrl(sender, type, mediaUrl);
              console.log(`✅ Sent ${type}: ${mediaUrl} to ${sender}`);
            } catch (err) {
              console.error("Failed to send attachment:", err.response?.data || err.message);
              // continue to next media instead of stopping
            }
            // small delay between sends to be polite and avoid rate limits
            await new Promise(r => setTimeout(r, 700));
          }

          // Final welcome/closing message after all media
          const welcome = `Hi! 👋 Thanks for messaging us.
Please provide your Car, Year, Model, and Variant so we can assist you faster. We'll get back as soon as possible.`;
          await sendText(sender, welcome);

          // mark as served
          servedUsers[sender] = Date.now();
          saveServedUsers();
          console.log(`Marked ${sender} as served.`);
        }
      } catch (err) {
        console.error("Error while handling message:", err);
      }
    }
  });

  res.status(200).send("EVENT_RECEIVED");
});

// ---------- Admin endpoints ----------
app.get("/admin/reset", (req, res) => {
  const { psid, key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  if (!psid) return res.send("No PSID provided");
  if (servedUsers[psid]) {
    delete servedUsers[psid];
    saveServedUsers();
    console.log(`Cleared memory for ${psid}`);
    return res.send(`Cleared memory for ${psid}`);
  } else {
    return res.send(`No record found for ${psid}`);
  }
});

app.get("/admin/reset-all", (req, res) => {
  const { key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  const count = Object.keys(servedUsers).length;
  servedUsers = {};
  saveServedUsers();
  console.log(`✅ Cleared ALL served users memory (${count} entries)`);
  res.send(`✅ All served users cleared (${count})`);
});

// health check
app.get("/", (req, res) => {
  res.send("Messenger Autoreply bot is running.");
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Bot server is running on port ${PORT}`);
  console.log(`Public URL (for local testing formation): ${PUBLIC_URL}`);
});
