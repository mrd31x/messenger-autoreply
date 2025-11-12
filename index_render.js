/**
 * index_render.js
 * Messenger auto-reply bot for Render
 * - Cloudinary manifest (cloudinary_manifest.json)
 * - Chunked media gallery (max 6 elements per template)
 * - Mark user served BEFORE sending to avoid duplicate sends
 * - Dedupe incoming events by message.mid
 * - Admin endpoints: /admin/reset and /admin/reset-all (protected by RESET_KEY)
 *
 * Env variables (configure in Render):
 *   PAGE_ACCESS_TOKEN  - required
 *   VERIFY_TOKEN       - default "mybot123"
 *   ADMIN_IDS          - comma-separated PSIDs (default includes 9873052959403429)
 *   COOLDOWN_DAYS      - default 30
 *   RESET_KEY          - default reset1531
 *   PORT               - default 10000
 */

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// ----------------- CONFIG -----------------
const PAGE_ACCESS_TOKEN= "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_IDS = (process.env.ADMIN_IDS || "9873052959403429")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const RESET_KEY = process.env.RESET_KEY || "reset1531";
const PORT = process.env.PORT || 10000;

const MEMORY_FILE = path.join(__dirname, "served_users.json");
const CLOUDINARY_FILE = path.join(__dirname, "cloudinary_manifest.json");

// ----------------- MEMORY & DEDUPE -----------------
let servedUsers = {}; // stores timestamps: servedUsers[psid] = timestamp
let lastMids = {};    // stores last processed message id per sender to dedupe
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf8");
      servedUsers = raw ? JSON.parse(raw) : {};
      // ensure lastMids is separate and not persisted here (optional)
    } else {
      servedUsers = {};
    }
  } catch (e) {
    console.error("Failed to load memory:", e);
    servedUsers = {};
  }
}
function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save memory:", e);
  }
}
loadMemory();

// ----------------- UTIL: load cloudinary manifest -----------------
function loadCloudinaryManifest() {
  try {
    if (!fs.existsSync(CLOUDINARY_FILE)) return [];
    const raw = fs.readFileSync(CLOUDINARY_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // filter only valid http(s) urls
    return arr.filter(u => typeof u === "string" && u.startsWith("http"));
  } catch (e) {
    console.error("Error loading cloudinary manifest:", e);
    return [];
  }
}

// ----------------- MESSENGER SEND HELPERS -----------------
async function callSendAPI(payload) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is not set.");
  const api = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(api, payload);
}

async function sendText(psid, text) {
  const payload = { recipient: { id: psid }, message: { text } };
  try {
    await callSendAPI(payload);
  } catch (err) {
    console.error("sendText error:", err.response?.data || err.message);
  }
}

// chunked gallery sender (safe max 6 elements per chunk)
async function sendGalleryChunks(psid, mediaUrls) {
  if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) return;
  const maxChunk = 6; // safe chunk size
  for (let i = 0; i < mediaUrls.length; i += maxChunk) {
    const chunk = mediaUrls.slice(i, i + maxChunk);
    // build media elements for "media" template
    const elements = chunk.map(url => ({
      media_type: /\.mp4|\.mov|\.webm/i.test(url) ? "video" : "image",
      url
    }));

    const payload = {
      recipient: { id: psid },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "media",
            elements
          }
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
    // small delay to reduce throttling / avoid webhook retries overlap
    await new Promise(r => setTimeout(r, 700));
  }
}

// ----------------- WEBHOOK VERIFICATION -----------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ----------------- MAIN WEBHOOK (incoming messages) -----------------
app.post("/webhook", async (req, res) => {
  try {
    if (req.body.object !== "page") return res.sendStatus(404);

    const mediaUrls = loadCloudinaryManifest(); // load fresh each request
    const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // process entries
    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        // ignore echo messages (from page itself)
        if (event.message && event.message.is_echo) continue;

        const sender = event.sender && event.sender.id;
        if (!sender) continue;

        // dedupe by message.mid when available
        const mid = event.message && event.message.mid;
        if (mid) {
          if (!lastMids[sender]) lastMids[sender] = mid;
          else if (lastMids[sender] === mid) {
            console.log("Duplicate mid, skipping:", mid);
            continue;
          } else {
            lastMids[sender] = mid;
          }
        }

        console.log("Incoming message from:", sender);

        const isAdmin = ADMIN_IDS.includes(String(sender));
        const lastServed = servedUsers[sender] || 0;
        const withinCooldown = !isAdmin && lastServed && (now - lastServed < cooldownMs);

        if (withinCooldown) {
          console.log(`User already served within cooldown, skipping media for: ${sender}`);
          // optional short ack
          await sendText(sender, "Thanks — we received your message and will get back to you shortly.");
          continue;
        }

        // Mark served BEFORE sending to avoid duplicate sends on webhook retries
        servedUsers[sender] = Date.now();
        saveMemory();

        // Send gallery in safe chunks (carousel)
        if (mediaUrls.length > 0) {
          await sendGalleryChunks(sender, mediaUrls);
        } else {
          console.log("No media URLs found in cloudinary_manifest.json");
        }

        // final welcome message after all media
        const welcome = `Hi! 👋 Thanks for messaging us.
Please provide your Car, Year, Model, and Variant so we can assist you faster.`;
        await sendText(sender, welcome);

      } // end for event
    } // end for entry

    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook handler error:", err.response?.data || err.message || err);
    res.sendStatus(500);
  }
});

// ----------------- ADMIN ENDPOINTS -----------------
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
  console.log(`✅ Cleared ALL memory (${count})`);
  res.send(`✅ All served users cleared (${count})`);
});

// health
app.get("/", (req, res) => res.send("Messenger bot running"));

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log(`✅ Bot server is running on port ${PORT}`);
  console.log(`Admin PSIDs: ${ADMIN_IDS.join(", ")}`);
});
