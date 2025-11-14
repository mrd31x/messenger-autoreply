// index_render.js – Render-ready Messenger auto-reply with MongoDB persistence
// - Reuses your working bot logic
// - Stores served users in MongoDB so Render sleeping doesn't reset cooldowns
// - Requires env var MONGODB_URI

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
app.use(bodyParser.json());

// === CONFIG - prefer Render env vars ===
const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN ||
  "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const ADMIN_RESET_KEY = process.env.ADMIN_RESET_KEY || "reset1531";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30); // media cooldown
const FOLLOWUP_HOURS = Number(process.env.FOLLOWUP_HOURS || 3); // follow-up cooldown
const PORT = process.env.PORT || 10000;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 3); // media per carousel chunk

// MONGODB
const MONGODB_URI = process.env.MONGODB_URI || ""; // set this in Render env vars
const MONGODB_DBNAME = process.env.MONGODB_DBNAME || "messenger_autoreply";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "served_users";

// === FILE PATHS (still used for manifest + media list) ===
const MANIFEST_PATH = path.join(__dirname, "cloudinary_manifest.json");

// === LOAD MEDIA LIST ===
let mediaUrls = [];
try {
  if (fs.existsSync(MANIFEST_PATH)) {
    mediaUrls = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    console.log(`✅ Loaded ${mediaUrls.length} Cloudinary media files`);
  } else {
    console.log("⚠️ cloudinary_manifest.json not found (no media loaded)");
  }
} catch (e) {
  console.error("❌ Failed to read cloudinary_manifest.json:", e.message);
}

// In-memory cache (keeps speed); persisted to MongoDB on changes
let served = {}; // { psid: { lastMedia: Number, lastFollowup: Number } }

// Deduplicate incoming message ids
const mids = new Set();

// Mongo client/collection handles
let mongoClient = null;
let servedCollection = null;

// === REPLY TEXTS (multiline strings) ===
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

// Price other bulb types placeholder — edit as needed
const REPLY_PRICE_OTHER_TYPES = `💡 For Other Bulb Types / Single Beam Bulbs:

🔥 P2,395 / pair
30,000 Lumens (Best Seller)
Available: H11, HB3, 9005, 9006, 9012, H7, H1, H3, H27, etc.

💸 Budget Variant (12K–15K Lumens):
P1,195 – P1,495 / pair
...`;

const REPLY_PRODUCT_SPECS = `Product Specs:
Power: 120W / 30,000 Lumens
Voltage: 9V–36V (fits most vehicles)
Waterproof: IP67
Material: Aviation Aluminum + Copper PCB
Rotation: 360° Adjustable
Lifespan: Up to 50,000 hours
✅ High brightness, durable, waterproof & all-weather ready!`;

const REPLY_INSTALLATION = `We offer FREE installation po if you’re within our area.
For shipping naman po, we have COD/COP via LBC, and we also send a video installation guide for easy setup.`;

const WELCOME_MESSAGE = `Hi! 👋 Thanks for messaging us.
Please provide your Car, Year, Model, and Variant so we can assist you faster.`;

// === FACEBOOK SEND HELPERS ===
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

// typing helpers
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
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
async function sendSmartTyping(psid, text) {
  try {
    const chars = (text || "").length;
    // 40 ms/char, min 700ms, max 40000ms
    const ms = Math.min(40000, Math.max(700, Math.round(chars * 40)));
    console.log(`🕑 Typing for ${ms}ms (chars=${chars})`);
    await sendTyping(psid, ms);
  } catch (e) {
    console.error("❌ sendSmartTyping error:", e.response?.data || e.message);
    await sendTyping(psid, 900);
  }
}

// quick replies helper (Location removed)
async function sendQuickRepliesList(psid) {
  const quickReplies = {
    recipient: { id: psid },
    message: {
      text: "You can also tap an option below 👇",
      quick_replies: [
        { content_type: "text", title: "How to order?", payload: "HOW_TO_ORDER" },
        { content_type: "text", title: "How much H4?", payload: "HOW_MUCH_H4" },
        { content_type: "text", title: "Price other bulb types", payload: "PRICE_OTHER_TYPES" },
        { content_type: "text", title: "Product specs?", payload: "PRODUCT_SPECS" },
        { content_type: "text", title: "Installation?", payload: "INSTALLATION" }
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

// media chunk sender (generic template)
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
    console.log(`✅ Sent ${urls.length}-item chunk to ${psid}`);
  } catch (e) {
    console.error("❌ Image chunk error:", e.response?.data || e.message);
    // fallback: send individually (image or video)
    for (const u of urls) {
      try {
        await fbSend({
          recipient: { id: psid },
          message: {
            attachment: { type: u.endsWith(".mp4") ? "video" : "image", payload: { url: u } },
          },
        });
        await sleep(400);
      } catch (err) {
        console.error("❌ single media error:", err.response?.data || err.message);
      }
    }
  }
}

async function sendAllMedia(psid) {
  if (!mediaUrls || mediaUrls.length === 0) return;
  const chunks = [];
  for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE) {
    chunks.push(mediaUrls.slice(i, i + CHUNK_SIZE));
  }
  for (const c of chunks) {
    await sendTyping(psid, 700);
    await sendChunk(psid, c);
    await sleep(800);
  }
}

// === MONGODB helpers ===
async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI not set - served_users will be memory-only (Render sleep will reset).");
    return;
  }
  try {
    // NOTE: do not pass legacy options (useNewUrlParser / useUnifiedTopology) — newer drivers
    // use sensible defaults and will error if you pass those names.
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();

    const db = mongoClient.db(MONGODB_DBNAME);
    servedCollection = db.collection(MONGODB_COLLECTION);

    // create index on psid for fast upsert/find (idempotent)
    await servedCollection.createIndex({ psid: 1 }, { unique: true });

    console.log("✅ Connected to MongoDB");
    // load existing served users into memory cache
    const docs = await servedCollection.find({}).toArray();
    for (const d of docs) {
      served[d.psid] = { lastMedia: d.lastMedia || 0, lastFollowup: d.lastFollowup || 0 };
    }
    console.log(`✅ Loaded ${docs.length} served users from MongoDB`);
  } catch (e) {
    console.error("❌ MongoDB connect failed:", e.message);
    servedCollection = null;
  }
}

async function upsertServed(psid, data) {
  served[psid] = data;
  if (!servedCollection) return;
  try {
    await servedCollection.updateOne({ psid }, { $set: { psid, ...data } }, { upsert: true });
  } catch (e) {
    console.error("❌ upsertServed error:", e.message);
  }
}

async function deleteServed(psid) {
  delete served[psid];
  if (!servedCollection) return;
  try {
    await servedCollection.deleteOne({ psid });
  } catch (e) {
    console.error("❌ deleteServed error:", e.message);
  }
}

async function clearAllServed() {
  served = {};
  if (!servedCollection) return;
  try {
    await servedCollection.deleteMany({});
  } catch (e) {
    console.error("❌ clearAllServed error:", e.message);
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
  // respond quickly to FB
  res.sendStatus(200);
  if (req.body.object !== "page") return;

  for (const entry of req.body.entry || []) {
    for (const ev of entry.messaging || []) {
      const psid = ev.sender?.id;
      const mid = ev.message?.mid;
      if (!psid || (mid && mids.has(mid))) continue;
      if (mid) mids.add(mid);
      if (!ev.message || ev.message.is_echo) continue;
      console.log("💬 Incoming from:", psid);

      // quick-reply payload handling
      const quickPayload = ev.message?.quick_reply?.payload;
      if (quickPayload) {
        console.log("🎯 Quick reply payload:", quickPayload);
        if (quickPayload === "HOW_TO_ORDER") {
          await sendSmartTyping(psid, REPLY_HOW_TO_ORDER);
          await sendText(psid, REPLY_HOW_TO_ORDER);
          await sleep(300);
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
        if (quickPayload === "PRICE_OTHER_TYPES") {
          await sendSmartTyping(psid, REPLY_PRICE_OTHER_TYPES);
          await sendText(psid, REPLY_PRICE_OTHER_TYPES);
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
          await sleep(300);
          await sendQuickRepliesList(psid);
          continue;
        }
      }

      // text keyword triggers (also resend quick replies)
      const text = (ev.message?.text || "").toLowerCase();
      if (text.includes("how to order")) {
        await sendSmartTyping(psid, REPLY_HOW_TO_ORDER);
        await sendText(psid, REPLY_HOW_TO_ORDER);
        await sleep(300);
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
      if (text.includes("other bulb") || text.includes("price other")) {
        await sendSmartTyping(psid, REPLY_PRICE_OTHER_TYPES);
        await sendText(psid, REPLY_PRICE_OTHER_TYPES);
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
        await sleep(300);
        await sendQuickRepliesList(psid);
        continue;
      }

      // ---------- cooldown & media sending ----------
      const now = Date.now();
      const user = served[psid] || { lastMedia: 0, lastFollowup: 0 };
      const cooldown = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      const followupWindow = FOLLOWUP_HOURS * 60 * 60 * 1000;

      // if still within media cooldown
      if (now - user.lastMedia < cooldown) {
        // maybe send follow-up if follow-up window passed
        if (now - user.lastFollowup >= followupWindow) {
          const followText = "Thanks for your message!😊, We’ll get back to you shortly. Thank you!";
          await sendSmartTyping(psid, followText);
          await sendText(psid, followText);
          user.lastFollowup = now;
          await upsertServed(psid, user);
          console.log("📩 Sent follow-up to", psid);
        } else {
          console.log("⏱ Still in cooldown, skipping media for", psid);
        }
        continue;
      }

      // not in cooldown — send media + welcome
      user.lastMedia = now;
      user.lastFollowup = now;
      await upsertServed(psid, user);

      await sendAllMedia(psid);

      if (WELCOME_MESSAGE && WELCOME_MESSAGE.length) {
        await sendSmartTyping(psid, WELCOME_MESSAGE);
        await sendText(psid, WELCOME_MESSAGE);
      }

      await sleep(250);
      await sendQuickRepliesList(psid);
    }
  }
});

// === ADMIN RESET ROUTES ===
// reset all memory
app.get("/admin/reset-all", async (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  await clearAllServed();
  console.log("🧹 Admin reset: all users cleared");
  res.send("✅ All users cleared from memory");
});

// reset follow-up only (12hr) for one PSID
app.get("/admin/reset-followup", async (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  const psid = req.query.psid;
  if (!psid) return res.status(400).send("Missing psid");
  if (!served[psid]) return res.send(`ℹ️ PSID ${psid} not found`);
  served[psid].lastFollowup = 0;
  await upsertServed(psid, served[psid]);
  console.log(`🔁 Cleared follow-up for ${psid}`);
  res.send(`✅ Cleared follow-up for PSID: ${psid}`);
});

// reset one PSID fully (media+followup)
app.get("/admin/reset-all-admin", async (req, res) => {
  if (req.query.key !== ADMIN_RESET_KEY) return res.status(403).send("Forbidden");
  const psid = req.query.psid;
  if (!psid) return res.status(400).send("Missing psid");
  await deleteServed(psid);
  console.log(`🔁 Fully reset admin memory for ${psid}`);
  res.send(`✅ Fully reset admin memory (media + follow-up) for PSID: ${psid}`);
});

// health check
app.get("/", (req, res) => res.send("✅ Messenger bot running fine"));

// start server AFTER connecting to MongoDB so served in-memory cache is populated
async function start() {
  await connectMongo();
  app.listen(PORT, () => console.log(`🚀 Bot live on port ${PORT}`));
}
start().catch((e) => {
  console.error("❌ Failed to start:", e.message);
  // still start server even if mongo unavailable
  app.listen(PORT, () => console.log(`🚀 Bot live (mongo unavailable) on port ${PORT}`));
});
