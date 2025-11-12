f// index.js - Messenger Bot (Render / local ready)
// Requirements: npm install express body-parser axios
// Put your media list in cloudinary_manifest.json (JSON array of URLs).
// Environment variables required:
//   PAGE_ACCESS_TOKEN  (your page token)
//   VERIFY_TOKEN       (verify token used in FB dashboard)
// Optional env vars:
//   COOLDOWN_DAYS      (default 30)
//   ADMIN_IDS          (comma-separated PSIDs, e.g. "123,456")
//   RESET_KEY          (secret string to allow hitting /admin/reset)

// ---- imports ----
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ---- config ----
const PORT = process.env.PORT || 3000;
const PAGE_ACCESS_TOKEN = "EAAQ2omfzFccBP1EqtZCGsAvYgQsqsCTEG4fZAUFbKUNXenrNfKBlfr9HnaWZCWuE355E4PodmrItrugB7Y44zGQ8LoDHWsbj4mqB4aYYxHdrjA8tuQ0on6uL1ahmiENXoGar3VrOrlywPr3GW6oFsqy9QutMir8ZBT21b3p4S7PfAYwxD08hBKrQeHpm3R3fec77"|| "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mybot123";
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 30);
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const RESET_KEY = process.env.RESET_KEY || ""; // set a secret to protect /admin/reset

if (!PAGE_ACCESS_TOKEN) {
  console.warn("⚠️ Warning: PAGE_ACCESS_TOKEN not set. Set env var PAGE_ACCESS_TOKEN before deploying.");
}

// Files
const SERVED_FILE = path.join(__dirname, "served_users.json");
const MANIFEST_FILE = path.join(__dirname, "cloudinary_manifest.json");

// ---- helpers: memory file ----
let servedUsers = {};
try {
  if (fs.existsSync(SERVED_FILE)) {
    servedUsers = JSON.parse(fs.readFileSync(SERVED_FILE, "utf8") || "{}");
  } else {
    fs.writeFileSync(SERVED_FILE, JSON.stringify({}), "utf8");
    servedUsers = {};
  }
} catch (e) {
  console.error("Error loading served_users.json:", e);
  servedUsers = {};
}
function saveServedUsers() {
  try {
    fs.writeFileSync(SERVED_FILE, JSON.stringify(servedUsers, null, 2), "utf8");
  } catch (e) {
    console.error("Error saving served_users.json:", e);
  }
}

// ---- helpers: utilities ----
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function isAdminSender(senderId) {
  return ADMIN_IDS.includes(String(senderId));
}

// ---- helpers: messenger send ----
function sendMessage(senderId, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const data = {
    recipient: { id: senderId },
    message: { text }
  };
  return axios.post(url, data).catch(err => {
    console.error("Unable to send text message:", err.response?.data || err.message);
  });
}

async function sendMediaCarousel(senderId, imageUrls = []) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return;
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  // FB generic template has practical limits; use safe chunk size 6
  const maxChunkSize = 6;
  const chunks = chunkArray(imageUrls, maxChunkSize);

  for (const chunk of chunks) {
    const elements = chunk.map((imgUrl, idx) => ({
      title: `Photo ${idx + 1}`,
      image_url: imgUrl,
      default_action: {
        type: "web_url",
        url: imgUrl,
        webview_height_ratio: "tall"
      }
    }));

    const payload = {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements
          }
        }
      }
    };

    try {
      await axios.post(url, payload);
      console.log(`✅ sent media carousel chunk (${chunk.length} items) to ${senderId}`);
      await new Promise(r => setTimeout(r, 400)); // small throttle
    } catch (err) {
      console.error("❌ Error sending media template:", err.response?.data || err.message);
    }
  }
}

// ---- load manifest helper ----
function loadManifestUrls() {
  try {
    if (!fs.existsSync(MANIFEST_FILE)) {
      console.warn("Manifest file not found:", MANIFEST_FILE);
      return [];
    }
    const raw = fs.readFileSync(MANIFEST_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      console.warn("Manifest should be a JSON array of URLs.");
      return [];
    }
    // filter out invalid-looking entries
    return arr.filter(u => typeof u === "string" && u.startsWith("http"));
  } catch (e) {
    console.error("Error loading manifest:", e);
    return [];
  }
}

// ---- Express app ----
const app = express();
app.use(bodyParser.json());
// serve local media folder if you keep local files (optional)
app.use("/media", express.static(path.join(__dirname, "media")));

// verification endpoint for FB
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

// admin reset endpoint (protected by RESET_KEY) - optional for testing
// Example: /admin/reset?psid=123456&key=your_reset_key
app.get("/admin/reset", (req, res) => {
  const key = req.query.key || "";
  const psid = req.query.psid;
  if (!RESET_KEY || key !== RESET_KEY) {
    return res.status(403).send("Forbidden - invalid reset key");
  }
  if (!psid) return res.status(400).send("Missing psid param");
  if (servedUsers[psid]) {
    delete servedUsers[psid];
    saveServedUsers();
    console.log("Admin reset cleared for", psid);
    return res.send(`Cleared memory for ${psid}`);
  }
  return res.send(`No record for ${psid}`);
});

// webhook POST handler (incoming messages)
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    // load media manifest fresh each event (so you can update urls without restart)
    const mediaUrls = loadManifestUrls();

    for (const entry of body.entry || []) {
      const event = (entry.messaging && entry.messaging[0]) || null;
      if (!event) continue;
      const sender = event.sender && event.sender.id;
      if (!sender) continue;

      console.log("Incoming message from:", sender);

      // only handle messages (you can expand to postbacks etc)
      if (event.message) {
        // if the message has text or attachments - treat as trigger
        const now = Date.now();
        const servedTimestamp = servedUsers[sender] || 0;
        const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
        const passedCooldown = (now - servedTimestamp) > cooldownMs;

        // Admins bypass memory for testing
        if (isAdminSender(sender) || !servedUsers[sender] || passedCooldown) {
          // send carousel grouping of media
          if (mediaUrls.length > 0) {
            await sendMediaCarousel(sender, mediaUrls);
          } else {
            console.log("No media URLs found to send.");
          }

          // send welcome text AFTER media
          await sendMessage(sender, "Hi! 👋 Thanks for messaging us. We’ll get back to you shortly. For faster transactions, please send us your car’s YEAR, MODEL and VARIANT. Thank you! 🚗💨");

          // record served timestamp for non-admins
          if (!isAdminSender(sender)) {
            servedUsers[sender] = Date.now();
            saveServedUsers();
          } else {
            console.log("Admin sender - memory not updated (test mode).");
          }
        } else {
          console.log("User already served within cooldown, skipping media for:", sender);
          // optional: send short acknowledgement for repeated messages
          // await sendMessage(sender, "Thanks — we received your message and will reply shortly.");
        }
      }
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.sendStatus(500);
  }
});

// root or health check
app.get("/", (req, res) => {
  res.send("Messenger bot running.");
});

// start
app.listen(PORT, () => {
  console.log(`✅ Bot server is running on port ${PORT}`);
});
