// index_render.js – Clean stable Messenger auto-reply (Render-ready + admin reset routes + quick replies)
// Includes: resend quick-reply list after each reply (so options remain visible)
// Added: smart typing indicator + small delays for more natural feel
// Typing timing: 40 ms per character, min 700 ms, max 40,000 ms

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
  if (fs.existsSync(MEMORY_PATH)) served = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
} catch (e) {}
const saveMemory = () => fs.writeFileSync(MEMORY_PATH, JSON.stringify(served, null, 2));

// Deduplicate message IDs
const mids = new Set();

// === REPLY TEXTS (multiline using backticks) ===
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

const REPLY_HOW_MUCH_H4 = `H4 Type Led Bulb

P2,495 / pair

Product Specs:
120W | 30,000 Lumens | IP67 Waterproof | Canbus Ready | 360° Adjustable | 50,000 hrs lifespan

✅ Super bright, durable, waterproof & easy to install!`;
const REPLY_PRODUCT_SPECS = `Product Specs:
Power: 120W / 30,000 Lumens
Voltage: 9V–36V (fits most vehicles)
Waterproof: IP67
Material: Aviation Aluminum + Copper PCB
Rotation: 360° Adjustable
Temp Range: -40°C to 180°C
Lifespan: Up to 50,000 hours
Super Heat Dissipation
Canbus Ready (No Error)
Easy, Nondestructive Installation

✅ High brightness, durable, waterproof & all-weather ready!
`;
const REPLY_INSTALLATION = `We offer FREE installation po if you’re within our area.
For shipping naman po, we have COD/COP via LBC, and we also send a video installation guide for easy setup. `;
const REPLY_LOCATION = `📍 We’re based in Iloilo po!
We’re the main distributor of AD LED nationwide.

Direct from manufacturer — kaya mas mura kahit high-end specs pa ang mga products namin!

We also have resellers in some parts of the Philippines, pero higher price na po compared to us.

We offer home service installation within nearby areas,
and Cash on Delivery (COD) via LBC for provincial and far locations.

Marami na rin po kaming customers from Luzon, NCR and Manila pa po mismo — kasi mas mahal daw po mga LED sa shops doon.😅

Saan po location nyo boss? ☺️`;

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

// --- Typing helpers ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTyping(psid, ms = 1200) {
  try {
    await fbSend({ recipient: { id: psid }, sender_action: "typing_on" });
    await sleep(ms);
    await fbSend({ recipient: { id: psid }, sender_action: "typing_off" });
  } catch (e) {
    console.error("❌ sendTyping error:", e.response?.data || e.message);
  }
}

// Smart typing based on message length (40 ms per char, min 700ms, max 40000ms)
async function sendSmartTyping(psid, text) {
  try {
    const chars = (text || "").length;
    // 40 ms per char, min 700ms, max 40000ms (40 seconds)
    const ms = Math.min(40000, Math.max(700, Math.round(chars * 40)));
    await sendTyping(psid, ms);
  } catch (e) {
    console.error("❌ sendSmartTyping error:", e.response?.data || e.message);
    // fallback to short typing
    await sendTyping(psid, 900);
  }
}

// send quick-reply list helper (keeps options visible after replies)
async function sendQuickRepliesList(psid) {
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
    console.log("✅ Quick replies sent to", psid);
  } catch (e) {
    console.error("❌ quickReplies send error:", e.response?.data || e.message);
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
      }).catch((err) => console.error("❌ single media error:", err.response?.data || err.message));
      await sleep(800);
    }
  }
}

async function sendAllMedia(psid) {
  const chunks = [];
  for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE) chunks.push(mediaUrls.slice(i, i + CHUNK_SIZE));
  for (const c of chunks) {
    // show typing briefly before each media chunk to feel natural
    await sendTyping(psid, 700);
    await sendChunk(psid, c);
    await sleep(800);
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

      // ---------- quick-reply payload handling ----------
      const quickPayload = ev.message?.quick_reply?.payload;
      if (quickPayload) {
        console.log("🎯 Quick reply payload:", quickPayload);

        if (quickPayload === "HOW_TO_ORDER") {
          await sendSmartTyping(psid, REPLY_HOW_TO_ORDER);
          await sendText(psid, REPLY_HOW_TO_ORDER);
          await sleep(350);
          await sendQuickRepliesList(psid);
          continue;
        }
        if (quickPayload === "HOW_MUCH_H4") {
          await sendSmartTyping(psid, REPLY_HOW_MUCH_H4);
          await sendText(psid, REPLY_HOW_MUCH_H4);
          await sleep(300);
          await sendQuickRepliesList(psid);
          continue;
        }
        if (quickPayload === "PRODUCT_SPECS") {
          await sendSmartTyping(psid, REPLY_PRODUCT_SPECS);
          await sendText(psid, REPLY_PRODUCT_SPECS);
          await sleep(300);
          await sendQuickRepliesList(psid);
          continue;
        }
        if (quickPayload === "INSTALLATION") {
          await sendSmartTyping(psid, REPLY_INSTALLATION);
          await sendText(psid, REPLY_INSTALLATION);
          await sleep(350);
          await sendQuickRepliesList(psid);
          continue;
        }
        if (quickPayload === "LOCATION") {
          await sendSmartTyping(psid, REPLY_LOCATION);
          await sendText(psid, REPLY_LOCATION);
          await sleep(300);
          await sendQuickRepliesList(psid);
          continue;
        }
      }

      // ---------- keyword triggers (also resend quick replies) ----------
      const text = ev.message?.text?.toLowerCase?.() || "";
      if (text.includes("how to order")) {
        await sendSmartTyping(psid, REPLY_HOW_TO_ORDER);
        await sendText(psid, REPLY_HOW_TO_ORDER);
        await sleep(350);
        await sendQuickRepliesList(psid);
        continue;
      }
      if (text.includes("how much h4")) {
        await sendSmartTyping(psid, REPLY_HOW_MUCH_H4);
        await sendText(psid, REPLY_HOW_MUCH_H4);
        await sleep(300);
        await sendQuickRepliesList(psid);
        continue;
      }
      if (text.includes("product specs")) {
        await sendSmartTyping(psid, REPLY_PRODUCT_SPECS);
        await sendText(psid, REPLY_PRODUCT_SPECS);
        await sleep(300);
        await sendQuickRepliesList(psid);
        continue;
      }
      if (text.includes("install")) {
        await sendSmartTyping(psid, REPLY_INSTALLATION);
        await sendText(psid, REPLY_INSTALLATION);
        await sleep(350);
        await sendQuickRepliesList(psid);
        continue;
      }
      if (text.includes("location")) {
        await sendSmartTyping(psid, REPLY_LOCATION);
        await sendText(psid, REPLY_LOCATION);
        await sleep(300);
        await sendQuickRepliesList(psid);
        continue;
      }

      // ---------- cooldown & media sending ----------
      const now = Date.now();
      const user = served[psid] || { lastMedia: 0, lastFollowup: 0 };
      const cooldown = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      const followupWindow = FOLLOWUP_HOURS * 60 * 60 * 1000;

      if (now - user.lastMedia < cooldown) {
        if (now - user.lastFollowup >= followupWindow) {
          await sendSmartTyping(psid, "We will get back to you as soon as we can. Thank you!");
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

      // mark served and save
      user.lastMedia = now;
      user.lastFollowup = now;
      served[psid] = user;
      saveMemory();

      // send media chunks
      await sendAllMedia(psid);

      // send welcome message after media (if set)
      if (WELCOME_MESSAGE && WELCOME_MESSAGE.length) {
        await sendSmartTyping(psid, WELCOME_MESSAGE);
        await sendText(psid, WELCOME_MESSAGE);
      }

      // finally show quick replies (so they see options right away)
      await sleep(250);
      await sendQuickRepliesList(psid);
    }
  }
});

// === ADMIN RESET ROUTES ===
// Reset all users
app.get("/admin/reset-all", (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  served = {};
  saveMemory();
  console.log("🧹 Admin reset: all users cleared");
  res.send("✅ All users cleared from memory");
});

// Reset only follow-up (12-hour cooldown) for a PSID
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

// Reset only one PSID’s full memory (media + follow-up)
app.get("/admin/reset-all-admin", (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  const psid = req.query.psid;
  if (!psid) return res.status(400).send("Missing psid");
  if (served[psid]) delete served[psid];
  saveMemory();
  console.log(`🔁 Fully reset admin memory for ${psid}`);
  res.send(`✅ Fully reset admin memory (media + follow-up) for PSID: ${psid}`);
});

// Health check
app.get("/", (req, res) => res.send("✅ Messenger bot running fine"));

app.listen(PORT, () => console.log(`🚀 Bot live on port ${PORT}`));
