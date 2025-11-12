// index_render.js — clean rebuild
// Render-ready Messenger Bot using Cloudinary media

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// ====== CONFIG ======
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_IDS = (process.env.ADMIN_IDS || "9873052959403429").split(",");
const RESET_KEY = process.env.RESET_KEY || "reset1531";
const COOLDOWN_DAYS = 30;
const PORT = process.env.PORT || 10000;

// ====== FILE PATHS ======
const CLOUDINARY_FILE = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_FILE = path.join(__dirname, "served_users.json");

// ====== MEMORY ======
let servedUsers = {};
try {
  if (fs.existsSync(MEMORY_FILE)) {
    servedUsers = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  }
} catch {
  servedUsers = {};
}

// Save memory safely
function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2));
}

// ====== HELPERS ======
function loadCloudinaryManifest() {
  try {
    const data = fs.readFileSync(CLOUDINARY_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function callSendAPI(payload) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  await axios.post(url, payload);
}

// ====== MESSAGING FUNCTIONS ======
async function sendText(psid, text) {
  try {
    await callSendAPI({ recipient: { id: psid }, message: { text } });
  } catch (err) {
    console.error("sendText error:", err.response?.data || err.message);
  }
}

// send images (chunk 3 max), then videos
async function sendMedia(psid, mediaUrls) {
  const images = mediaUrls.filter(x => !x.match(/\.(mp4|mov|webm)$/i));
  const videos = mediaUrls.filter(x => x.match(/\.(mp4|mov|webm)$/i));

  // split images into groups of 3
  const chunkSize = 3;
  for (let i = 0; i < images.length; i += chunkSize) {
    const group = images.slice(i, i + chunkSize);
    const elements = group.map(url => ({ media_type: "image", image_url: url }));
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
      console.log(`✅ Sent image group (${group.length})`);
    } catch (e) {
      console.error("❌ Image send error:", e.response?.data || e.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  // videos one by one
  for (const v of videos) {
    const payload = {
      recipient: { id: psid },
      message: {
        attachment: {
          type: "video",
          payload: { url: v, is_reusable: true },
        },
      },
    };
    try {
      await callSendAPI(payload);
      console.log("✅ Sent video:", v);
    } catch (e) {
      console.error("❌ Video send error:", e.response?.data || e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ====== WEBHOOK VERIFY ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified.");
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});

// ====== MAIN HANDLER ======
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // immediate response

  (async () => {
    const body = req.body;
    if (body.object !== "page") return;

    const now = Date.now();
    const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const mediaUrls = loadCloudinaryManifest();

    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        if (!event.sender || !event.sender.id) continue;
        const psid = event.sender.id;
        const lastServed = servedUsers[psid] || 0;
        const isAdmin = ADMIN_IDS.includes(psid);
        const withinCooldown = !isAdmin && now - lastServed < cooldownMs;

        if (withinCooldown) {
          console.log(`Cooldown active for ${psid}`);
          return;
        }

        servedUsers[psid] = now;
        saveMemory();

        await sendMedia(psid, mediaUrls);
        await sendText(
          psid,
          "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
        );
      }
    }
  })();
});

// ====== ADMIN RESET ======
app.get("/admin/reset", (req, res) => {
  const { psid, key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  delete servedUsers[psid];
  saveMemory();
  res.send(`✅ Memory cleared for ${psid}`);
});

app.get("/admin/reset-all", (req, res) => {
  const { key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  servedUsers = {};
  saveMemory();
  res.send("✅ All users cleared");
});

// ====== HEALTH ======
app.get("/", (req, res) => res.send("✅ Messenger bot is running fine"));

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`);
  console.log(`✅ Loaded ${loadCloudinaryManifest().length} Cloudinary media files`);
});
