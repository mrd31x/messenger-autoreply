// index_render.js – Final Clean Cloudinary Gallery Version
// Features: 30-day memory, admin reset, gallery send, welcome last

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// --- CONFIGURATION ---
const PAGE_ACCESS_TOKEN= "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_IDS = (process.env.ADMIN_IDS || "9873052959403429").split(",");
const RESET_KEY = process.env.RESET_KEY || "reset1531";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const PORT = process.env.PORT || 10000;

const MEMORY_FILE = path.join(__dirname, "served_users.json");
const CLOUDINARY_FILE = path.join(__dirname, "cloudinary_manifest.json");

// --- MEMORY HANDLER ---
let servedUsers = {};
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      servedUsers = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    }
  } catch (err) {
    servedUsers = {};
  }
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Failed to save memory:", err);
  }
}
loadMemory();

// --- LOAD CLOUDINARY MEDIA ---
function loadCloudinaryMedia() {
  try {
    if (fs.existsSync(CLOUDINARY_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLOUDINARY_FILE, "utf8"));
      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ Loaded ${data.length} Cloudinary media items`);
        return data;
      }
    }
  } catch (err) {
    console.error("Error loading Cloudinary manifest:", err);
  }
  return [];
}

// --- MESSENGER HELPERS ---
async function callSendAPI(payload) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  await axios.post(url, payload);
}

async function sendText(senderId, text) {
  await callSendAPI({
    recipient: { id: senderId },
    message: { text },
  });
}

// Send media as a grouped gallery carousel (not flooding)
async function sendGallery(senderId, mediaUrls) {
  const elements = mediaUrls.slice(0, 10).map(url => ({
    media_type: url.match(/\.mp4|\.mov|\.webm/i) ? "video" : "image",
    attachment_id: null,
    url,
  }));

  const payload = {
    recipient: { id: senderId },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "media",
          elements,
        },
      },
    },
  };

  try {
    await callSendAPI(payload);
    console.log(`✅ Sent ${elements.length} media in carousel to ${senderId}`);
  } catch (err) {
    console.error("❌ Media send error:", err.response?.data || err.message);
  }
}

// --- WEBHOOK VERIFICATION ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified!");
      res.status(200).send(challenge);
    } else res.sendStatus(403);
  }
});

// --- MAIN MESSAGE HANDLER ---
app.post("/webhook", async (req, res) => {
  if (req.body.object !== "page") return res.sendStatus(404);

  const mediaUrls = loadCloudinaryMedia();
  const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const entry of req.body.entry) {
    for (const event of entry.messaging) {
      const sender = event.sender.id;
      if (!sender || (event.message && event.message.is_echo)) continue;

      const isAdmin = ADMIN_IDS.includes(String(sender));
      const lastServed = servedUsers[sender] || 0;
      const withinCooldown = !isAdmin && lastServed && now - lastServed < cooldownMs;

      try {
        if (withinCooldown) {
          await sendText(sender, "Thanks — we received your message and will get back to you soon!");
          continue;
        }

        // mark user served before sending
        servedUsers[sender] = Date.now();
        saveMemory();

        // send media as carousel
        await sendGallery(sender, mediaUrls);

        // final welcome message (after all)
        await sendText(
          sender,
          "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
        );
      } catch (err) {
        console.error("❌ Error handling message:", err);
      }
    }
  }

  res.sendStatus(200);
});

// --- ADMIN ROUTES ---
app.get("/admin/reset", (req, res) => {
  const { psid, key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  if (!psid) return res.send("No PSID provided");
  delete servedUsers[psid];
  saveMemory();
  res.send(`✅ Cleared memory for user ${psid}`);
});

app.get("/admin/reset-all", (req, res) => {
  const { key } = req.query;
  if (key !== RESET_KEY) return res.status(403).send("Invalid key");
  const count = Object.keys(servedUsers).length;
  servedUsers = {};
  saveMemory();
  res.send(`✅ All served users cleared (${count})`);
});

// --- START SERVER ---
app.get("/", (req, res) => res.send("Messenger Bot is running!"));
app.listen(PORT, () => console.log(`✅ Bot running on port ${PORT}`));
