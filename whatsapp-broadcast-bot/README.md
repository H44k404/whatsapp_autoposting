# WhatsApp Media Approval & Broadcast Bot

A Node.js bot that watches one WhatsApp group for new photos/videos, asks the
owner for approval in a private DM, and — on approval — broadcasts the exact
same media to a set of target groups.

> ⚠️ **Where this runs:** This is a persistent Node.js background service (a
> long-lived WhatsApp Web socket connection via [Baileys](https://github.com/WhiskeySockets/Baileys)).
> It is **not** a Cloudflare Workers/Pages app and cannot be deployed there —
> Workers has no persistent connections, no filesystem, and a hard per-request
> CPU cap. Run this on your own machine, a small VPS, or a Node-capable host
> (Railway, Fly.io, Render worker, a Raspberry Pi, etc.) with PM2 keeping it
> alive, per Section 7 below.

## Project Overview
- **Goal**: Automate "review then broadcast" media distribution across WhatsApp groups, gated by a human YES/NO approval step.
- **Flow**: Main group → media detected → approval DM sent to owner → owner replies YES/NO (regex, with optional Ollama NLU for natural-language replies) → approved media forwarded to all target groups (or discarded on NO/timeout).
- **Tech stack**: Node.js 18+, [Baileys](https://github.com/WhiskeySockets/Baileys) (`baileys@6.7.24`, patched — see Security Note below) for the WhatsApp Web protocol, JSON-file persistence for pending approvals, optional local [Ollama](https://ollama.com) for NLU/captioning, PM2 for process management.

## ⚠️ Read Before Using
- **Unofficial API**: Baileys mimics WhatsApp Web's protocol; it is **not** WhatsApp's official Business API. Using it technically violates WhatsApp's Terms of Service. Risk is generally low for small personal/low-volume use but accounts *can* be flagged or banned.
- **Use a secondary WhatsApp number for the bot**, not your primary number. Add it as a normal member to the main group and all target groups, and have it in a DM with your own number (the "control chat").
- **Delays are built in** between each group send (`BROADCAST_DELAY_MS`, default 3000ms) to reduce spam-detection risk. Don't remove them, and don't scale this beyond personal/small-team use.
- **Security note**: `baileys@6.17.16` had a known message-spoofing vulnerability ([GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg)). This project pins `baileys@6.7.24`, the latest patched stable v6 release (`npm audit` reports 0 vulnerabilities as of this build). Do not downgrade below `6.7.22`.
- **API correction vs. the original spec**: the roadmap this was built from suggested `sock.copyNForward(jid, msg, false)` for re-sending media. That method **does not exist** in the Baileys API (verified against the installed version). The correct, working approach — used in `src/broadcaster.js` — is Baileys' built-in forward message type: `sock.sendMessage(jid, { forward: originalMsg, force: true })`, which re-sends the original message's media without re-uploading it.

## Project Structure
```
whatsapp-broadcast-bot/
├── package.json
├── .env / .env.example
├── config/groups.json        # main group JID + 10 target group JIDs
├── auth/                     # Baileys session (auto-generated after QR scan; gitignored)
├── data/pending_approvals.json  # runtime state (gitignored)
├── src/
│   ├── index.js               # entry point — wires everything together
│   ├── whatsapp.js            # Baileys connection + reconnect logic
│   ├── discover-groups.js     # one-time script to find group JIDs
│   ├── approval.js            # approval request/response state machine
│   ├── broadcaster.js         # forwards approved media to target groups
│   ├── ollama.js              # optional NLU (yes/no parsing) + caption summarization
│   ├── store.js               # JSON-file persistence for pending approvals
│   └── utils/logger.js
├── test/dry-run.js            # mocked-socket test suite (no real WhatsApp connection needed)
└── README.md
```

## Setup

### 1. Install dependencies
```bash
cd whatsapp-broadcast-bot
npm install
```

### 2. Discover your group JIDs (one-time)
```bash
npm run discover-groups
```
- Scan the printed QR code with the **bot's WhatsApp number** (Settings → Linked Devices → Link a Device).
- The script prints every group the bot's number is currently in, as `<jid> - <group name>`.
- It also prints `[DM] Message from <jid>` for any DM it receives — message the bot from your own number to capture your `CONTROL_CHAT_JID`.
- Copy the relevant JIDs into `config/groups.json` (`mainGroup` + 10 `targetGroups`) and into `.env` (`CONTROL_CHAT_JID`, `MAIN_GROUP_JID`).
- Stop the script (Ctrl+C) once you have what you need — it's a one-time setup tool, not meant to run continuously.

### 3. Configure `.env`
Copy `.env.example` → `.env` if you haven't already, and fill in:
```env
CONTROL_CHAT_JID=947XXXXXXXX@s.whatsapp.net
MAIN_GROUP_JID=xxxxxxxxxx@g.us
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=admin123
SESSION_SECRET=replace-with-a-strong-secret
NODE_ENV=production
DASHBOARD_PORT=3001
APPROVAL_TIMEOUT_MINUTES=30
BROADCAST_DELAY_MS=3000
USE_OLLAMA=true
OLLAMA_MODEL=llama3.2
OLLAMA_URL=http://localhost:11434
LOG_LEVEL=info
```

> Use a strong `SESSION_SECRET` in production. The dashboard login is protected by `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`.

### 4. Run it
```bash
npm run dev     # nodemon, auto-restarts on file changes
# or
npm start       # plain node
```
Scan the QR code once more with the bot's number if `./auth` is empty (first real run). After that, the session persists — no repeated QR scans needed across restarts.

### 5. Test
Run the mocked-socket test suite (no live WhatsApp connection required):
```bash
node test/dry-run.js
```
This exercises: approval → broadcast, rejection, single-pending implicit YES, timeout expiry, and multi-pending disambiguation. All 5 scenarios / 15 assertions pass in this build.

For a live end-to-end test, follow the roadmap's original test plan:
1. Post a test image in the main group from another account.
2. Confirm the bot DMs an approval prompt to the control chat.
3. Reply `YES` → confirm the image lands in all target groups.
4. Repeat with a video.
5. Reply `NO` → confirm nothing is sent.
6. Don't reply, wait past `APPROVAL_TIMEOUT_MINUTES` → confirm the expiry message and no send.
7. With `USE_OLLAMA=true`, try a natural-language reply (e.g. "yeah go for it") → confirm it's classified as YES.
8. Restart the process → confirm it reconnects without re-scanning the QR code.

## Deployment (keep it running 24/7)
```bash
npm install -g pm2
pm2 start src/index.js --name whatsapp-broadcast-bot
pm2 save
pm2 startup     # follow the printed instructions to auto-start on machine reboot
pm2 logs whatsapp-broadcast-bot --nostream   # check logs without blocking
```

## Data & Persistence
- **Pending approvals**: `data/pending_approvals.json` — keyed by 8-char request ID, holds the raw original WhatsApp message object, media type, caption, timestamp, and status. Deleted once resolved (approved/rejected) or expired.
- **Group config**: `config/groups.json` — `mainGroup` (source) + `targetGroups` (array of 10 destination JIDs).
- **Auth session**: `auth/` — Baileys' multi-file credential store, created after the first successful QR scan. **Back this up** — losing it means re-linking the device.
- None of this is committed to git (`.gitignore` excludes `auth/`, `.env`, and `data/pending_approvals.json`).

## User Guide
1. Post an image or video in the main WhatsApp group.
2. Check the control chat (your DM with the bot) — you'll get a message like:
   ```
   🆕 New image received.
   ID: a1b2c3d4
   <short description>

   Reply "YES a1b2c3d4" or "NO a1b2c3d4" to confirm.
   (Or just reply YES/NO if this is the only pending item.)
   ```
3. Reply `YES <id>` to broadcast it to all target groups, or `NO <id>` to discard it.
4. If multiple approvals are pending at once, you'll be asked to include the explicit ID — always safe to do this regardless.
5. If you don't reply within `APPROVAL_TIMEOUT_MINUTES`, the request auto-expires and nothing is sent.

## Known Limitations / Not Yet Implemented
- **Vision-based captioning**: Ollama currently only summarizes the media's *caption text*, not the actual image/video pixels. Switching `OLLAMA_MODEL` to a vision model (e.g. `llava`) and passing image bytes as base64 would enable real visual captioning — not implemented here.
- **Per-group selection**: Approval currently always broadcasts to *all* configured target groups. Selecting a subset (e.g. `YES a1b2c3d4 groups:1,2,5`) is not implemented.
- **SQLite persistence**: Pending approvals use a flat JSON file, fine for low volume. Swap `src/store.js` for a SQLite-backed version if volume grows.
- **Web dashboard**: No UI for viewing pending/sent history — everything happens via WhatsApp replies and PM2 logs.

## Deployment Status
- **Platform**: Not deployed — this is a local/self-hosted Node.js service, delivered as source for you to run on your own machine or server.
- **Tested**: Module loading, mocked end-to-end approval/broadcast/reject/timeout/disambiguation logic (`test/dry-run.js`, all passing), and live QR-code generation against WhatsApp's real servers (connection handshake confirmed working). Full live broadcast to real groups was **not** tested in this environment (no physical phone available to scan the QR code here) — please run the live test plan above once you scan in with your bot number.
- **Last updated**: 2026-08-04
