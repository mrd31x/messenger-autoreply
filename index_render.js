// index_render.js – Render-ready with multiline replies (uses template literals)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// === CONFIG ===
const PAGE_ACCESS_TOKEN =
  "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77";
const VERIFY_TOKEN = "mybot123";
const ADMIN_RESET_KEY = "reset1531";
const COOLDOWN_DAYS = 30;
const FOLLOWUP_HOURS = 12;
const PORT = process.env.PORT || 10000;
const CHUNK_SIZE = 3;

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

// === PLACEHOLDERS (multiline strings use backticks) ===
const REPLY_HOW_TO_ORDER = `Hi! 😊
Here’s how to order:

🚚 Shipping via LBC

💳 Payment Options:
• COP — Pay at LBC branch when you pick up your package
• COD — Pay the rider upon delivery

💸 Shipping Fee (approx):
COP ₱120–₱150 | COD ₱185–₱230
(depends on location & package size)

Please send:
• Name
• Contact No.
• Address
• Zip Code
• LBC Branch (for COP)

Once details are complete, we’ll confirm your order right away.
Thank you! 🙏`;

const REPLY_HOW_MUCH_H4 = `Our H4 bulbs start at ₱XXX. Please tell us which car model and year for exact fit and price.`;

const REPLY_PRODUCT_SPECS = `Product specs:
• Type: H4
• Wattage: 55W
• Color temp: 6000K (example)
• Lifespan: 20,000 hours
(Adjust to your real specs)`;

const REPLY_INSTALLATION = `Installation (quick guide):
1. Turn off the engine and lights.
2. Open headlamp housing.
3. Remove old bulb carefully.
4. Insert new bulb, secure clip, test lights.
If unsure, please have a mechanic install it for you.`;

const REPLY_LOCATION = `We are located at: Your Shop Address
Business hours: Mon–Sat 9:00–18:00
Contact: 0917-XXX-XXXX`;

const WELCOME_MESSAGE = `Hi! 👋 Thanks for messaging us.
Please provide your Car, Year, Model, and Variant so we can assist you faster.`;

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

      // quick reply payloads
      const quickPayload = ev.message?.quick_reply?.payload;
      if (quickPayload) {
        if (quickPayload === "HOW_TO_ORDER") return sendText(psid, REPLY_HOW_TO_ORDER);
        if (quickPayload === "HOW_MUCH_H4") return sendText(psid, REPLY_HOW_MUCH_H4);
        if (quickPayload === "PRODUCT_SPECS") return sendText(psid, REPLY_PRODUCT_SPECS);
        if (quickPayload === "INSTALLATION") return sendText(psid, REPLY_INSTALLATION);
        if (quickPayload === "LOCATION") return sendText(psid, REPLY_LOCATION);
      }

      const text = ev.message?.text?.toLowerCase?.() || "";
      if (text.includes("how to order")) return sendText(psid, REPLY_HOW_TO_ORDER);
      if (text.includes("how much h4")) return sendText(psid, REPLY_HOW_MUCH_H4);
      if (text.includes("product specs")) return sendText(psid, REPLY_PRODUCT_SPECS);
      if (text.includes("install")) return sendText(psid, REPLY_INSTALLATION);
      if (text.includes("location")) return sendText(psid, REPLY_LOCATION);

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

      if (WELCOME_MESSAGE && WELCOME_MESSAGE.length) {
        await sendText(psid, WELCOME_MESSAGE);
      }

      const quickReplies = {
        recipient: { id: psid },
        message: {
          text: "You can also tap an option below 👇",
          quick_replies: [
            { content_type: "text", title: "How to order?", payload: "HOW_TO_ORDER" },
            { content_type: "text", title: "How much H4?", payload: "HOW_MUCH_H4" },
            { content_type: "text", title: "Product specs?", payload: "PRODUCT_SPECS" },
            { content_type: "text", title: "Installation?", payload: "INSTALLATION" },
            { content_type: "text", title: "Location?", payload: "LOCATION" },
          ],
        },
      };
      try {
        await fbSend(quickReplies);
      } catch (e) {
        console.error("❌ quickReplies send error:", e.response?.data || e.message);
      }
    }
  }
});

// === ADMIN RESET ROUTES ===
app.get("/admin/reset-all", (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  served = {};
  saveMemory();
  console.log("🧹 Admin reset: all users cleared");
  res.send("✅ All users cleared from memory");
});

app.get("/admin/reset-followup", (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  const psid = req.query.psid;
  if (!psid) return res.status(400).send("Missing psid");
  if (!served[psid]) return res.send(`ℹ️ PSID ${psid} not found`);
  served[psid].lastFollowup = 0;
  saveMemory();
  console.log(`🔁 Cleared follow-up for ${psid}`);
  res.send(`✅ Cleared follow-up for PSID: ${psid}`);
});

app.get("/admin/reset-all-admin", (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  const psid = req.query.psid;
  if (!psid) return res.status(400).send("Missing psid");
  if (served[psid]) delete served[psid];
  saveMemory();
  console.log(`🔁 Fully reset admin memory for ${psid}`);
  res.send(`✅ Fully reset admin memory for PSID: ${psid}`);
});

app.get("/", (req, res) => res.send("✅ Messenger bot running fine"));
app.listen(PORT, () => console.log(`🚀 Bot live on port ${PORT}`));
