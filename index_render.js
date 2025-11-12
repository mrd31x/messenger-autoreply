// index_render.js — Messenger Auto-reply Bot (Render Ready)
// 🧩 Updated: 3-chunk gallery + cooldown follow-up message

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express().use(bodyParser.json());

// === CONFIG ===
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "YOUR_PAGE_ACCESS_TOKEN";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const PORT = process.env.PORT || 10000;
const COOLDOWN_DAYS = 30;
const MEDIA_CHUNK_SIZE = 3; // send only 3 media per group
const FOLLOWUP_TEXT = "We received your message and will get back to you as soon as we can. Thank you.";

// === LOAD MEMORY ===
const memoryFile = path.join(__dirname, "served_users.json");
let servedUsers = {};
if (fs.existsSync(memoryFile)) {
  try {
    servedUsers = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
  } catch {
    servedUsers = {};
  }
}

// === HELPERS ===
const fbSend = (payload) =>
  axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, payload);

const saveMemory = () => fs.writeFileSync(memoryFile, JSON.stringify(servedUsers, null, 2));

// split array into chunks
const chunkArray = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// === LOAD CLOUDINARY MEDIA ===
let cloudMedia = [];
try {
  const manifestPath = path.join(__dirname, "cloudinary_manifest.json");
  cloudMedia = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(`✅ Loaded ${cloudMedia.length} Cloudinary media files`);
} catch (e) {
  console.error("❌ Could not load cloudinary_manifest.json", e.message);
}

// === SEND FUNCTIONS ===

// send single text message
async function sendMessage(psid, text) {
  const payload = { recipient: { id: psid }, message: { text } };
  try {
    await fbSend(payload);
    console.log(`💬 text sent to ${psid}`);
  } catch (e) {
    console.error("❌ Text send error:", e.response?.data || e.message);
  }
}

// send gallery chunk of up to 3 media items
async function sendChunk(psid, urls) {
  const elements = urls.map((url) => {
    const isVideo = /\/video\/|\.mp4|\.mov|\.webm/i.test(url);
    return { media_type: isVideo ? "video" : "image", url };
  });

  const payload = {
    recipient: { id: psid },
    message: { attachment: { type: "template", payload: { template_type: "media", elements } } },
  };

  try {
    await fbSend(payload);
    console.log(`✅ Sent ${urls.length} media items to ${psid}`);
  } catch (err) {
    console.error("❌ Media send error:", err.response?.data || err.message);
  }
}

// send all media in 3-item groups
async function sendAllMedia(psid) {
  const chunks = chunkArray(cloudMedia, MEDIA_CHUNK_SIZE);
  for (const group of chunks) {
    await sendChunk(psid, group);
    await new Promise((r) => setTimeout(r, 1000)); // 1s delay between groups
  }
}

// === WEBHOOKS ===
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") return res.sendStatus(404);
  for (const entry of body.entry) {
    const event = entry.messaging && entry.messaging[0];
    if (!event || !event.sender || !event.sender.id) continue;
    const psid = event.sender.id;

    if (event.message && event.message.text) {
      const now = Date.now();
      const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      const lastServed = servedUsers[psid] || 0;

      if (now - lastServed > cooldownMs) {
        // first time or expired
        servedUsers[psid] = now;
        saveMemory();

        const welcomeText =
          "Hi! 👋 Thanks for messaging us. Please provide your Car, Year, Model, and Variant so we can assist you faster. Here are some of our sample photos and videos.";
        await sendMessage(psid, welcomeText);
        await sendAllMedia(psid);
        console.log(`✅ Full media + welcome sent to ${psid}`);
      } else {
        // within cooldown — send one follow-up message
        await sendMessage(psid, FOLLOWUP_TEXT);
        console.log(`💬 follow-up sent to ${psid}`);
      }
    }
  }
  res.status(200).send("EVENT_RECEIVED");
});

// === SERVER START ===
app.listen(PORT, () => console.log(`✅ Bot running on port ${PORT}`));
