// index_render.js – stable Messenger auto-reply (Render-ready + admin reset route)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// === CONFIG ===
const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN ||
  "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_RESET_KEY = process.env.ADMIN_RESET_KEY || "reset1531";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const FOLLOWUP_HOURS = Number(process.env.FOLLOWUP_HOURS || 12);
const PORT = process.env.PORT || 10000;
const CHUNK_SIZE = 3; // number of media per carousel

// === FILE PATHS ===
const MANIFEST_PATH = path.join(__dirname, "cloudinary_manifest.json");
const MEMORY_PATH = path.join(__dirname, "served_users.json");

// === LOAD MEDIA ===
let mediaUrls = [];
try {
  if (fs.existsSync(MANIFEST_PATH)) {
    mediaUrls = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    console.log(`✅ Loaded ${mediaUrls.length} Cloudinary media files`);
  } else console.log("⚠️ cloudinary_manifest.json not found");
} catch (e) {
  console.error("❌ Failed to load media manifest:", e.message);
}

// === LOAD MEMORY ===
let served = {};
try {
  if (fs.existsSync(MEMORY_PATH))
    served = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
} catch {}
const saveMemory = () =>
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(served, null, 2));

// Deduplicate message IDs
const mids = new Set();

// === HELPERS ===
async function fbSend(payload) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  return axios.post(url, payload);
}

async function sendText(psid, text) {
  try {
    await fbSend({ recipient: { id: psid }, message: { text } });
    console.log("✅ Sent text to", psid);
  } catch (e) {
    console.error("❌ sendText error:", e.response?.data || e.message);
  }
}

async function sendChunk(psid, urls) {
  const elements = urls.map((url, i) => ({
    title: url.endsWith(".mp4") ? `Video ${i + 1}` : `Photo ${i + 1}`,
    image_url: url,
    default_action: { type: "web_url", url },
  }));

  const msg = {
    recipient: { id: psid },
    message: {
      attachment: { type: "template", payload: { template_type: "generic", elements } },
    },
  };

  try {
    await fbSend(msg);
    console.log(`✅ Sent ${urls.length}-item chunk`);
  } catch (e) {
    console.error("❌ Image chunk error:", e.response?.data || e.message);
    // fallback: send individually
    for (const u of urls) {
      await fbSend({
        recipient: { id: psid },
        message: {
          attachment: {
            type: u.endsWith(".mp4") ? "video" : "image",
            payload: { url: u },
          },
        },
      }).catch((err) =>
        console.error("❌ single media error:", err.response?.data || err.message)
      );
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

async function sendAllMedia(psid) {
  const chunks = [];
  for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE)
    chunks.push(mediaUrls.slice(i, i + CHUNK_SIZE));

  for (const c of chunks) {
    await sendChunk(psid, c);
    await new Promise((r) => setTimeout(r, 800));
  }
}

// === WEBHOOKS ===
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  if (req.body.object !== "page") return;

  for (const entry of req.body.entry || []) {
    for (const ev of entry.messaging || []) {
      const psid = ev.sender?.id;
      const mid = ev.message?.mid;
      if (!psid || mids.has(mid)) continue;
      mids.add(mid);

      if (!ev.message || ev.message.is_echo) continue;
      console.log("💬 Incoming from:", psid);

      const now = Date.now();
      const user = served[psid] || { lastMedia: 0, lastFollowup: 0 };
      const cooldown = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      const followupWindow = FOLLOWUP_HOURS * 60 * 60 * 1000;

      if (now - user.lastMedia < cooldown) {
        if (now - user.lastFollowup >= followupWindow) {
          await sendText(psid, "We will get back to you as soon as we can. Thank you!");
          user.lastFollowup = now;
          served[psid] = user;
          saveMemory();
          console.log("📩 Sent follow-up message to", psid);
        } else {
          console.log("⏱ Still in cooldown, skipping media for", psid);
        }
        continue;
      }

      user.lastMedia = now;
      user.lastFollowup = now;
      served[psid] = user;
      saveMemory();

      await sendAllMedia(psid);
      await sendText(
        psid,
        "Hi! 👋 Thanks for messaging us.\nPlease provide your Car, Year, Model, and Variant so we can assist you faster."
      );
    }
  }
});

// === ADMIN RESET ROUTE ===
app.get("/admin/reset", (req, res) => {
  const key = req.query.key;
  const psid = req.query.psid;
  if (!key || key !== ADMIN_RESET_KEY) {
    return res.status(403).send("Forbidden: invalid key");
  }

  try {
    if (psid) {
      if (served[psid]) {
        delete served[psid];
        saveMemory();
        console.log(`🔁 Admin reset: cleared PSID ${psid}`);
        return res.send(`✅ Cleared cooldown for PSID: ${psid}`);
      } else {
        return res.send(`ℹ️ PSID ${psid} not found`);
      }
    } else {
      served = {};
      saveMemory();
      console.log("🔁 Admin reset: cleared all users");
      return res.send("✅ Cleared all users");
    }
  } catch (e) {
    console.error("❌ Admin reset error:", e);
    return res.status(500).send("Error performing reset");
  }
});

// === HEALTH ===
app.get("/", (req, res) => res.send("✅ Messenger bot running fine"));
// === ADMIN RESET ROUTES (unified) ===

// Reset all users
app.get("/admin/reset-all", (req, res) => {
  const key = req.query.key;
  if (!key || key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  served = {};
  saveMemory();
  console.log("🧹 Admin reset: all users cleared");
  res.send("✅ All users cleared from memory");
});

// Reset only follow-up (12-hour cooldown) for a PSID
app.get("/admin/reset-followup", (req, res) => {
  const key = req.query.key;
  const psid = req.query.psid;
  if (!key || key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  if (!psid) return res.status(400).send("Missing psid");

  if (!served[psid]) return res.send(`ℹ️ PSID ${psid} not found`);
  served[psid].lastFollowup = 0;
  saveMemory();
  console.log(`🔁 Admin: cleared follow-up for PSID ${psid}`);
  return res.send(`✅ Cleared follow-up timestamp for PSID: ${psid}`);
});

// Reset only one PSID’s full memory (media + follow-up)
app.get("/admin/reset-all-admin", (req, res) => {
  const key = req.query.key;
  const psid = req.query.psid;
  if (!key || key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  if (!psid) return res.status(400).send("Missing psid");

  if (served[psid]) delete served[psid]; // completely remove entry
  saveMemory();
  console.log(`🔁 Admin reset full memory for ${psid}`);
  res.send(`✅ Fully reset admin memory (media + follow-up) for PSID: ${psid}`);
});

app.listen(PORT, () => console.log(`🚀 Bot live on port ${PORT}`));
