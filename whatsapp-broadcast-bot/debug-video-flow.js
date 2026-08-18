#!/usr/bin/env node

/**
 * Debug script to trace video approval flow
 * Usage: node debug-video-flow.js
 */

const fs = require("fs");
const path = require("path");

// Load environment
require("dotenv").config();

// Import modules
const { getGroupName, getGroupNameCacheStats } = require("./src/utils/groupCache");
const { readAll, getPending, savePending, saveMediaBuffer, getMediaBuffer } = require("./src/store");
const logger = require("./src/utils/logger");

console.log("\n" + "=".repeat(60));
console.log("DEBUG: VIDEO APPROVAL FLOW");
console.log("=".repeat(60) + "\n");

// 1. Check configuration
console.log("[1] CHECKING CONFIGURATION");
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config/groups.json")));
  console.log(`   ✓ Main Group: ${config.mainGroup}`);
  console.log(`   ✓ Control Chat: ${config.controlChatJid}`);
  console.log(`   ✓ Target Groups: ${config.targetGroups?.length || 0}`);
} catch (e) {
  console.error(`   ✗ Error loading config: ${e.message}`);
}

// 2. Check data directory
console.log("\n[2] CHECKING DATA DIRECTORY");
const dataDir = path.join(__dirname, "data");
const mediaDir = path.join(dataDir, "media");
if (fs.existsSync(dataDir)) {
  console.log(`   ✓ data/ exists`);
  if (fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir);
    console.log(`   ✓ data/media/ exists (${files.length} files)`);
  } else {
    console.log(`   ✗ data/media/ missing`);
  }
} else {
  console.log(`   ✗ data/ directory missing`);
}

// 3. Check pending approvals
console.log("\n[3] CHECKING PENDING APPROVALS");
try {
  const all = readAll();
  const pending = Object.entries(all).filter(([, v]) => v.status === "pending");
  console.log(`   Total approvals: ${Object.keys(all).length}`);
  console.log(`   Pending approvals: ${pending.length}`);
  
  if (pending.length > 0) {
    for (const [id, item] of pending.slice(0, 5)) {
      const buffer = getMediaBuffer(id);
      const hasThumbnail = item.mediaMessage?.message?.videoMessage?.jpegThumbnail || 
                           item.mediaMessage?.message?.imageMessage?.jpegThumbnail;
      console.log(`   ├─ ${id} (${item.mediaType})`);
      console.log(`   │  ├─ Created: ${new Date(item.createdAt).toISOString()}`);
      console.log(`   │  ├─ Caption: ${(item.caption || "").substring(0, 50)}`);
      console.log(`   │  ├─ Has Buffer: ${!!buffer} ${buffer ? `(${buffer.length} bytes)` : ""}`);
      console.log(`   │  ├─ Has Thumbnail: ${!!hasThumbnail}`);
      console.log(`   │  └─ Source Group: ${item.sourceGroupName}`);
    }
  }
} catch (e) {
  console.error(`   ✗ Error reading approvals: ${e.message}`);
}

// 4. Test media buffer operations
console.log("\n[4] TESTING MEDIA BUFFER OPERATIONS");
try {
  const testId = "debug-test-" + Date.now();
  const testBuffer = Buffer.from("TEST_VIDEO_DATA_12345");
  
  saveMediaBuffer(testId, testBuffer, "video");
  const retrieved = getMediaBuffer(testId);
  
  if (retrieved && retrieved.toString() === testBuffer.toString()) {
    console.log(`   ✓ Media buffer save/retrieve working`);
    // Cleanup
    fs.unlinkSync(path.join(mediaDir, `${testId}.mp4`));
  } else {
    console.log(`   ✗ Media buffer save/retrieve failed`);
  }
} catch (e) {
  console.error(`   ✗ Error testing media buffer: ${e.message}`);
}

// 5. Check group cache
console.log("\n[5] CHECKING GROUP CACHE");
try {
  const stats = getGroupNameCacheStats();
  console.log(`   ✓ Cache size: ${stats.size} entries`);
  if (stats.size > 0) {
    for (const [jid, name] of Array.from(stats.entries).slice(0, 3)) {
      console.log(`   ├─ ${jid.substring(0, 20)}... → ${name}`);
    }
  }
} catch (e) {
  console.error(`   ✗ Error checking cache: ${e.message}`);
}

// 6. Check environment variables
console.log("\n[6] CHECKING ENVIRONMENT VARIABLES");
const env = {
  "MAIN_GROUP_JID": process.env.MAIN_GROUP_JID,
  "CONTROL_CHAT_JID": process.env.CONTROL_CHAT_JID,
  "APPROVAL_TIMEOUT_MINUTES": process.env.APPROVAL_TIMEOUT_MINUTES,
  "BROADCAST_DELAY_MS": process.env.BROADCAST_DELAY_MS,
};
for (const [key, val] of Object.entries(env)) {
  console.log(`   ✓ ${key}: ${val ? "SET" : "NOT SET"} ${val ? `(${(val + "").substring(0, 30)}...)` : ""}`);
}

// 7. Check module imports
console.log("\n[7] CHECKING MODULE IMPORTS");
try {
  require("./src/index");
  console.log(`   ✓ index.js loads successfully`);
} catch (e) {
  console.error(`   ✗ index.js error: ${e.message}`);
}

try {
  require("./src/server");
  console.log(`   ✓ server.js loads successfully`);
} catch (e) {
  console.error(`   ✗ server.js error: ${e.message}`);
}

console.log("\n" + "=".repeat(60));
console.log("DEBUG: NEXT STEPS");
console.log("=".repeat(60));
console.log(`
1. Send a video to the main group (${process.env.MAIN_GROUP_JID || "Not configured"})
2. Check the logs in the terminal to see if messages are being captured
3. Look for "Approval request sent to control chat" log message
4. Open the dashboard at http://localhost:3000
5. Verify the video appears in the Approvals section

If videos are not showing:
- Check browser console for errors
- Check Dashboard status (should show "connected")
- Send a test image first to verify approvals work in general
- Check Socket.IO connection logs

To view full logs, run:
  npm start 2>&1 | tee bot.log
`);
console.log("=".repeat(60) + "\n");
