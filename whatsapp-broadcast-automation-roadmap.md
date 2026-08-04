# WhatsApp Media Approval & Broadcast Automation — Full Build Roadmap

> **Purpose of this document:** This is a complete, step-by-step build specification for an AI coding agent (or a human developer) to implement a WhatsApp automation system from scratch. Follow the steps **in order**. Each step includes what to build, why, and how. Do not skip the config/testing steps.

---

## 0. What This System Does

1. Bot account is a member of **1 main WhatsApp group** and **10 target WhatsApp groups**.
2. When the main group receives a new **image or video**, the bot:
   - Downloads the media.
   - Sends it to a **private control chat** (the owner's own WhatsApp number/DM with the bot) with a prompt asking for approval, tagged with a unique request ID.
3. The owner replies **YES / NO** (or a natural-language equivalent) in the control chat.
4. If approved → bot sends that exact media to all 10 target groups.
5. If rejected or ignored (timeout) → bot discards the pending request and does nothing.
6. Optional: a locally hosted **Ollama** model is used to (a) parse natural-language approval replies, and (b) generate a short caption/classification of the media shown in the approval prompt.

---

## 1. Important Notes Before Starting (Read First)

- This uses **Baileys**, an open-source library that connects to WhatsApp using the same protocol as WhatsApp Web. It is **not** WhatsApp's official Business API.
- Using unofficial automation libraries technically violates WhatsApp's Terms of Service. Risk is generally low for small personal/low-volume use, but accounts *can* be flagged/banned, especially with high message volume or spam-like behavior.
- **Recommendation:** Use a secondary WhatsApp number for the bot (not the owner's primary number), added as a normal member to all 11 groups (main + 10 targets), and add it as a contact in the owner's control chat.
- Add delays between sends (2–5 seconds) when broadcasting to the 10 groups to reduce spam-detection risk.

---

## 2. Tech Stack

| Component | Tool | Why |
|---|---|---|
| WhatsApp connection | **Baileys** (`baileys` npm package) | Free, open-source, no browser overhead, supports media |
| Runtime | Node.js (v18+) | Baileys requirement |
| Persistence | Local JSON files (or SQLite if preferred) | Store auth session, group IDs, pending approvals |
| Optional NLU/captioning | **Ollama** (already running locally) | Free local LLM, no API cost |
| Process manager | **pm2** | Keeps the bot running persistently, auto-restarts on crash |

---

## 3. Prerequisites

- Node.js v18 or later installed.
- A phone with WhatsApp installed on the number that will act as the bot (ideally a secondary number).
- Ollama already running locally (confirm with `ollama list` and `ollama serve` reachable at `http://localhost:11434`).
- The bot's WhatsApp number must already be added to:
  - The 1 main group (source of media).
  - All 10 target groups (destinations).
  - A private chat with the owner (the "control chat" — this can simply be the owner messaging the bot's number directly, or vice versa).

---

## 4. Project Folder Structure

Create this exact structure:

```
whatsapp-broadcast-bot/
├── package.json
├── .env
├── .env.example
├── config/
│   └── groups.json
├── auth/                     # Baileys session data (auto-generated, gitignore this)
├── data/
│   └── pending_approvals.json
├── src/
│   ├── index.js              # Entry point
│   ├── whatsapp.js           # Baileys connection + event listeners
│   ├── approval.js           # Approval request/response logic
│   ├── broadcaster.js        # Sends media to the 10 groups
│   ├── ollama.js             # Optional: caption + intent parsing via Ollama
│   ├── store.js              # Read/write pending_approvals.json
│   └── utils/
│       └── logger.js
├── .gitignore
└── README.md
```

---

## 5. Step-by-Step Implementation

### Step 5.1 — Initialize the project

```bash
mkdir whatsapp-broadcast-bot && cd whatsapp-broadcast-bot
npm init -y
npm install baileys qrcode-terminal dotenv pino node-fetch
npm install -D nodemon
```

> `pino` is Baileys' recommended logger. `node-fetch` is for calling the local Ollama HTTP API (skip if using Node 18+ native `fetch`).

### Step 5.2 — Create `.env.example` and `.env`

```env
# .env.example
CONTROL_CHAT_JID=          # your personal number in format 947XXXXXXXX@s.whatsapp.net
MAIN_GROUP_JID=            # the source group's JID, ends in @g.us
APPROVAL_TIMEOUT_MINUTES=30
USE_OLLAMA=true
OLLAMA_MODEL=llama3.2
OLLAMA_URL=http://localhost:11434
```

Copy `.env.example` to `.env` and leave values blank for now — group JIDs are discovered in Step 5.4.

### Step 5.3 — Create `config/groups.json`

```json
{
  "mainGroup": "",
  "targetGroups": [
    "", "", "", "", "", "", "", "", "", ""
  ]
}
```

This will be filled in once JIDs are known (Step 5.4).

### Step 5.4 — Connect to WhatsApp and discover group JIDs

Create `src/whatsapp.js`:

```js
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

async function startBot(onReady) {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startBot(onReady);
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp");
      onReady(sock);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

module.exports = { startBot };
```

**One-time discovery script** — create `src/discover-groups.js` temporarily:

```js
const { startBot } = require("./whatsapp");

startBot((sock) => {
  sock.ev.on("groups.upsert", (groups) => {
    groups.forEach((g) => console.log(g.id, "-", g.subject));
  });
  // Also fetch all groups the bot is already in:
  (async () => {
    const list = await sock.groupFetchAllParticipating();
    Object.values(list).forEach((g) => console.log(g.id, "-", g.subject));
  })();
});
```

Run it once:

```bash
node src/discover-groups.js
```

- Scan the QR code shown in the terminal using the **bot's WhatsApp number** (Linked Devices → Link a Device).
- Copy the printed group IDs (format `xxxxxxxxxx@g.us`) into `config/groups.json` — one as `mainGroup`, ten as `targetGroups`.
- Copy the owner's own JID (format `countrycode+number@s.whatsapp.net`) into `.env` as `CONTROL_CHAT_JID`.
- Delete or stop using `discover-groups.js` after this — it's a one-time setup script.

### Step 5.5 — Build the media listener

Create `src/store.js` (simple JSON-based pending-approval store):

```js
const fs = require("fs");
const PATH = "./data/pending_approvals.json";

function readAll() {
  if (!fs.existsSync(PATH)) return {};
  return JSON.parse(fs.readFileSync(PATH, "utf-8"));
}

function writeAll(data) {
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

function savePending(id, entry) {
  const all = readAll();
  all[id] = entry;
  writeAll(all);
}

function getPending(id) {
  return readAll()[id];
}

function deletePending(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

module.exports = { savePending, getPending, deletePending, readAll };
```

### Step 5.6 — Build the Ollama helper (optional but recommended)

Create `src/ollama.js`:

```js
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "llama3.2";

async function classifyReply(text) {
  // Returns "yes", "no", or "unclear"
  const prompt = `The user was asked to approve sharing a media file to 10 WhatsApp groups.
Their reply was: "${text}"
Respond with ONLY one word: YES, NO, or UNCLEAR.`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false }),
  });
  const data = await res.json();
  const answer = (data.response || "").trim().toLowerCase();
  if (answer.includes("yes")) return "yes";
  if (answer.includes("no")) return "no";
  return "unclear";
}

async function describeMedia(caption) {
  if (!caption) return "New media (no caption)";
  const prompt = `Summarize this WhatsApp media caption in under 10 words: "${caption}"`;
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false }),
  });
  const data = await res.json();
  return (data.response || caption).trim();
}

module.exports = { classifyReply, describeMedia };
```

> Note: Ollama cannot see images/video content directly through this simple text prompt unless you use a vision-capable model (e.g. `llava`) and pass image data. For v1, only caption text is summarized. Vision support is an optional future upgrade (see Section 8).

### Step 5.7 — Build the approval flow

Create `src/approval.js`:

```js
const { v4: uuidv4 } = require("uuid"); // npm install uuid
const { savePending, getPending, deletePending } = require("./store");
const { classifyReply, describeMedia } = require("./ollama");
const { broadcastToGroups } = require("./broadcaster");

const CONTROL_CHAT = process.env.CONTROL_CHAT_JID;
const TIMEOUT_MS = (parseInt(process.env.APPROVAL_TIMEOUT_MINUTES) || 30) * 60000;

async function requestApproval(sock, mediaMessage, mediaType, caption) {
  const id = uuidv4().slice(0, 8);
  let description = caption || "";
  if (process.env.USE_OLLAMA === "true") {
    try {
      description = await describeMedia(caption);
    } catch (e) {
      console.log("Ollama describe failed, using raw caption:", e.message);
    }
  }

  savePending(id, {
    mediaMessage,
    mediaType,
    createdAt: Date.now(),
    status: "pending",
  });

  await sock.sendMessage(CONTROL_CHAT, {
    text: `🆕 New ${mediaType} received.\nID: *${id}*\n${description}\n\nReply "YES ${id}" or "NO ${id}" to confirm.\n(Or just reply YES/NO if this is the only pending item.)`,
  });

  // Auto-expire
  setTimeout(() => {
    const p = getPending(id);
    if (p && p.status === "pending") {
      deletePending(id);
      sock.sendMessage(CONTROL_CHAT, { text: `⌛ Request ${id} expired (no response).` });
    }
  }, TIMEOUT_MS);

  return id;
}

async function handleControlReply(sock, text) {
  const cleaned = text.trim();
  const match = cleaned.match(/([a-f0-9]{8})/i);
  let id = match ? match[1] : null;

  // If no ID given, apply to the single most recent pending request
  const allPending = require("./store").readAll();
  if (!id) {
    const pendingIds = Object.keys(allPending).filter((k) => allPending[k].status === "pending");
    if (pendingIds.length === 1) id = pendingIds[0];
  }
  if (!id || !allPending[id]) return; // nothing to do

  let decision = /^(yes|y)\b/i.test(cleaned) ? "yes" : /^(no|n)\b/i.test(cleaned) ? "no" : null;

  if (!decision && process.env.USE_OLLAMA === "true") {
    decision = await classifyReply(cleaned);
    if (decision === "unclear") {
      await sock.sendMessage(CONTROL_CHAT, { text: `❓ Couldn't tell if that's a YES or NO for ${id}. Please reply clearly.` });
      return;
    }
  }
  if (!decision) return;

  const entry = getPending(id);
  if (decision === "yes") {
    await sock.sendMessage(CONTROL_CHAT, { text: `✅ Broadcasting ${id} to all target groups...` });
    await broadcastToGroups(sock, entry.mediaMessage, entry.mediaType);
    await sock.sendMessage(CONTROL_CHAT, { text: `✅ Done broadcasting ${id}.` });
  } else {
    await sock.sendMessage(CONTROL_CHAT, { text: `🚫 Discarded ${id}.` });
  }
  deletePending(id);
}

module.exports = { requestApproval, handleControlReply };
```

### Step 5.8 — Build the broadcaster

Create `src/broadcaster.js`:

```js
const groups = require("../config/groups.json");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function broadcastToGroups(sock, mediaMessage, mediaType) {
  for (const jid of groups.targetGroups) {
    if (!jid) continue;
    try {
      await sock.sendMessage(jid, mediaMessage);
      console.log(`Sent to ${jid}`);
    } catch (e) {
      console.log(`Failed to send to ${jid}:`, e.message);
    }
    await delay(3000); // 3-second delay between groups to reduce spam flags
  }
}

module.exports = { broadcastToGroups };
```

> `mediaMessage` here should be built as a re-sendable content object — see Step 5.9 for how to construct it from the incoming message.

### Step 5.9 — Wire it all together in the main listener

Create `src/index.js`:

```js
require("dotenv").config();
const { startBot } = require("./whatsapp");
const { requestApproval, handleControlReply } = require("./approval");

const MAIN_GROUP = process.env.MAIN_GROUP_JID;
const CONTROL_CHAT = process.env.CONTROL_CHAT_JID;

startBot((sock) => {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid;

      // Case 1: media from the main group
      if (from === MAIN_GROUP) {
        const imageMsg = msg.message.imageMessage;
        const videoMsg = msg.message.videoMessage;
        if (imageMsg || videoMsg) {
          const mediaType = imageMsg ? "image" : "video";
          const caption = (imageMsg || videoMsg).caption || "";

          // Build a re-sendable message object by forwarding the raw message content
          const mediaMessage = imageMsg
            ? { image: { url: undefined }, caption, ...{ forward: msg } }
            : { video: { url: undefined }, caption, ...{ forward: msg } };

          // Simpler and more reliable: use sock.copyNForward for exact re-send
          await requestApproval(sock, msg, mediaType, caption);
        }
      }

      // Case 2: reply in control chat
      if (from === CONTROL_CHAT) {
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";
        if (text) await handleControlReply(sock, text);
      }
    }
  });
});
```

**Important correction for reliable forwarding:** Baileys provides `sock.copyNForward(jid, message, forceForward)` for exact re-sending of a received message (including media) to another JID without re-uploading it. Use this in `broadcaster.js` instead of manually rebuilding the media object:

```js
// Revised broadcaster.js core send line:
await sock.copyNForward(jid, mediaMessage, false);
```

And in `approval.js` / `index.js`, store `msg` (the full original message object) as `mediaMessage`, not a rebuilt object. Update Step 5.7 and 5.9 accordingly — pass the raw `msg` through.

### Step 5.10 — package.json scripts

```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js"
  }
}
```

Also run:
```bash
npm install uuid
```

---

## 6. Testing Plan

1. Run `npm run dev`, scan QR with the bot number.
2. Post a test image in the main group from another account.
3. Confirm the bot sends an approval prompt to the control chat.
4. Reply `YES` → confirm the image lands in all 10 target groups (check each).
5. Repeat with a video.
6. Test rejection: reply `NO` → confirm nothing is sent.
7. Test timeout: don't reply, wait past `APPROVAL_TIMEOUT_MINUTES` → confirm expiry message appears and nothing is sent.
8. Test natural language reply (e.g. "yeah go for it") with `USE_OLLAMA=true` → confirm it's correctly classified as YES.
9. Test bot restart: stop and restart the process → confirm it reconnects without re-scanning QR (auth session persisted in `/auth`).

---

## 7. Deployment (Keep It Running 24/7, Free)

```bash
npm install -g pm2
pm2 start src/index.js --name whatsapp-broadcast-bot
pm2 save
pm2 startup     # follow printed instructions to auto-start on machine reboot
```

Check logs anytime:
```bash
pm2 logs whatsapp-broadcast-bot
```

---

## 8. Optional Future Upgrades

- **Vision-based captioning:** Switch `OLLAMA_MODEL` to a vision model (e.g. `llava`) and pass the downloaded image buffer as base64 to Ollama's `/api/generate` with an `images` field, so the approval prompt describes what's actually *in* the photo/video thumbnail, not just the caption.
- **Multiple pending items support:** Currently one pending item is easiest to manage by ID; if multiple media arrive close together, always reply with the explicit ID (`YES a1b2c3d4`) to avoid ambiguity.
- **SQLite instead of JSON file** for `pending_approvals.json` if volume grows.
- **Per-group selection:** Extend the approval prompt to let the owner choose a subset of the 10 groups instead of always all 10 (e.g. reply `YES a1b2c3d4 groups:1,2,5`).
- **Web dashboard:** Small local Express + HTML page to view pending/sent history instead of relying only on WhatsApp replies.

---

## 9. Risk & Safety Checklist (Do Not Skip)

- [ ] Use a secondary WhatsApp number for the bot, not the owner's main number.
- [ ] Keep 2–5 second delays between each group send (already in `broadcaster.js`).
- [ ] Do not scale this to more than a personal/small-team use case — high volume increases ban risk significantly.
- [ ] Back up the `/auth` folder — losing it means re-scanning the QR code.
- [ ] Never commit `/auth`, `.env`, or `data/pending_approvals.json` to git — add them to `.gitignore`.

---

## 10. `.gitignore`

```
node_modules/
auth/
.env
data/pending_approvals.json
```

---

## 11. Build Order Summary (Checklist for the AI Agent)

- [ ] Step 5.1 — `npm init`, install dependencies
- [ ] Step 5.2 — create `.env` / `.env.example`
- [ ] Step 5.3 — create `config/groups.json` skeleton
- [ ] Step 5.4 — build `whatsapp.js`, run one-time group discovery, fill in JIDs
- [ ] Step 5.5 — build `store.js`
- [ ] Step 5.6 — build `ollama.js`
- [ ] Step 5.7 — build `approval.js`
- [ ] Step 5.8 — build `broadcaster.js` (using `sock.copyNForward`)
- [ ] Step 5.9 — build `index.js`, wire everything together, use raw `msg` object end-to-end
- [ ] Step 5.10 — add npm scripts
- [ ] Section 6 — run full test plan
- [ ] Section 7 — deploy with pm2
- [ ] Section 9 — confirm safety checklist items

**End state:** running `npm run dev` (or `pm2 start`) connects the bot, and posting media in the main group triggers an approval DM; a YES reply broadcasts to all 10 groups with delays; a NO or timeout discards it.
