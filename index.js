// ====== IMPORTS ======
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ====== APP SETUP ======
const app = express();
app.use(bodyParser.json());

// ====== CONFIG (ENV) ======
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"; // REQUIRED
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
if (!PAGE_ACCESS_TOKEN) {
  console.error("❌ Missing PAGE_ACCESS_TOKEN environment variable.");
  process.exit(1);
}

// ====== LOAD CLOUDINARY MANIFEST ======
const MANIFEST_PATH = path.join(__dirname, "cloudinary_manifest.json");
let cloudMedia = [];
try {
  const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Manifest must be a JSON array.");
  // Deduplicate + keep only supported types
  cloudMedia = Array.from(new Set(parsed.filter(u =>
    /\.(jpg|jpeg|png|gif|webp|mp4|mov|m4v|avi)(\?|$)/i.test(String(u))
  )));
  console.log(`✅ Loaded ${cloudMedia.length} media item(s) from cloudinary_manifest.json`);
} catch (e) {
  console.error("⚠️ Could not load cloudinary_manifest.json:", e.message);
  cloudMedia = [];
}

// ====== SIMPLE PERSISTENT MEMORY ======
// served_users.json structure:
// { "<PSID>": { firstRepliedAt: 1234567890, followupSent: true } }
const MEMORY_FILE = path.join(__dirname, "served_users.json");
let servedUsers = {};
try {
  if (fs.existsSync(MEMORY_FILE)) {
    servedUsers = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  }
} catch (e) {
  console.error("⚠️ Could not read memory file:", e.message);
  servedUsers = {};
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2));
  } catch (e) {
    console.error("⚠️ Could not write memory file:", e.message);
  }
}

// Anti-duplicate in-flight guard
const IN_FLIGHT = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ====== WEBHOOK VERIFY (GET) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ====== RECEIVE EVENTS (POST) ======
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry || []) {
      const event = entry.messaging && entry.messaging[0];
      if (!event) continue;

      const sender = event.sender && event.sender.id;
      if (!sender) continue;

      // Ignore echoes (prevents double sends)
      if (event.message && event.message.is_echo) continue;

      // Only react to real user text / attachments once
      const hasUserMessage = !!(event.message && (event.message.text || event.message.attachments));

      if (hasUserMessage) {
        // Prevent overlapping runs for the same user
        if (IN_FLIGHT.has(sender)) {
          console.log(`⏳ Skipping: already sending to ${sender}`);
          continue;
        }
        IN_FLIGHT.add(sender);

        try {
          const mem = servedUsers[sender] || { firstRepliedAt: null, followupSent: false };

          if (!mem.firstRepliedAt) {
            // FIRST TIME ONLY: send all media → then welcome
            console.log(`▶️ First-time flow for ${sender}`);
            await sendCloudMediaSequence(sender, cloudMedia, 900);
            await sleep(800);
            await sendText(
              sender,
              "Hi! 👋 Thanks for messaging us.\n" +
              "Please provide your **CAR, YEAR, MODEL, and VARIANT** so we can assist you faster.\n" +
              "Thank you!"
            );
            mem.firstRepliedAt = Date.now();
            servedUsers[sender] = mem;
            saveMemory();
            console.log("✅ First-time sequence complete.");
          } else if (!mem.followupSent) {
            // ONE-TIME FOLLOW-UP ONLY: let them know you'll get back
            console.log(`↩️ One-time follow-up for ${sender}`);
            await sendText(
              sender,
              "Hello! 😊 Thanks for messaging us. We’re currently away right now, but don’t worry — we’ll reply as soon as we’re back online. Your message is important to us!"
            );
            mem.followupSent = true;
            servedUsers[sender] = mem;
            saveMemory();
          } else {
            // SILENT after that (no more replies)
            console.log(`🤫 Silent mode for ${sender} (already sent welcome + follow-up).`);
          }
        } catch (err) {
          console.error("❌ Error handling message:", err.response?.data || err.message);
        } finally {
          IN_FLIGHT.delete(sender);
        }
      }
    }

    // Acknowledge quickly
    return res.status(200).send("EVENT_RECEIVED");
  }

  res.sendStatus(404);
});

// ====== HELPERS ======
function sendText(senderId, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const payload = { recipient: { id: senderId }, message: { text } };
  return axios.post(url, payload)
    .then(() => console.log("💬 text sent"))
    .catch(err => { throw err; });
}

function sendAttachment(senderId, type, mediaUrl) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const payload = {
    recipient: { id: senderId },
    message: {
      attachment: {
        type, // "image" | "video" | "audio" | "file"
        payload: { url: mediaUrl, is_reusable: true }
      }
    }
  };
  return axios.post(url, payload)
    .then(() => console.log(`📎 ${type} sent: ${mediaUrl}`))
    .catch(err => { throw err; });
}

async function sendCloudMediaSequence(senderId, urls, gapMs = 900) {
  if (!urls || !urls.length) {
    console.log("ℹ️ No media to send (manifest empty).");
    return;
  }
  for (const url of urls) {
    const isVideo = /\.(mp4|mov|m4v|avi)(\?|$)/i.test(url);
    const type = isVideo ? "video" : "image";
    await sendAttachment(senderId, type, url);
    await sleep(gapMs); // brief gap to respect rate limits
  }
}

// ====== START SERVER ======
const PORT = process.env.PORT || 3000; // Render uses process.env.PORT
app.listen(PORT, () => console.log(`✅ Bot server is running on port ${PORT}`));
