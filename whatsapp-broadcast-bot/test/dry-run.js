/**
 * Dry-run test harness — exercises the approval/broadcast logic WITHOUT a
 * real WhatsApp connection, using a mocked `sock` object. Not part of the
 * production bot; safe to delete once you've manually verified behavior on
 * a real WhatsApp connection.
 *
 * Run: node test/dry-run.js
 */
require("dotenv").config();
process.env.CONTROL_CHAT_JID = process.env.CONTROL_CHAT_JID || "1234567890@s.whatsapp.net";
process.env.USE_OLLAMA = "false"; // force regex-only classification for a deterministic test
process.env.APPROVAL_TIMEOUT_MINUTES = "0.02"; // ~1.2s, for testing the expiry path quickly

const path = require("path");
const fs = require("fs");

// Point store at a scratch file so we don't clobber real data/pending_approvals.json
const DATA_DIR = path.join(__dirname, "..", "data");
const REAL_FILE = path.join(DATA_DIR, "pending_approvals.json");
const BACKUP_FILE = path.join(DATA_DIR, "pending_approvals.json.bak-test");
if (fs.existsSync(REAL_FILE)) fs.copyFileSync(REAL_FILE, BACKUP_FILE);
fs.writeFileSync(REAL_FILE, "{}");

// Point groups.json at a scratch config
const GROUPS_PATH = path.join(__dirname, "..", "config", "groups.json");
const GROUPS_BACKUP = path.join(__dirname, "..", "config", "groups.json.bak-test");
fs.copyFileSync(GROUPS_PATH, GROUPS_BACKUP);
fs.writeFileSync(
  GROUPS_PATH,
  JSON.stringify({ mainGroup: "main@g.us", targetGroups: ["g1@g.us", "g2@g.us", "g3@g.us"] }, null, 2)
);
process.env.BROADCAST_DELAY_MS = "10"; // speed up the test

const { requestApproval, handleControlReply } = require("../src/approval");

function restore() {
  if (fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(BACKUP_FILE, REAL_FILE);
    fs.unlinkSync(BACKUP_FILE);
  } else {
    fs.writeFileSync(REAL_FILE, "{}");
  }
  fs.copyFileSync(GROUPS_BACKUP, GROUPS_PATH);
  fs.unlinkSync(GROUPS_BACKUP);
}

function makeMockSock() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { id: "mock-" + Math.random().toString(36).slice(2) } };
    },
  };
}

function assert(cond, msg) {
  if (!cond) {
    restore();
    console.error("❌ FAIL:", msg);
    process.exit(1);
  }
  console.log("✅ PASS:", msg);
}

async function testApproveFlow() {
  console.log("\n--- Test 1: approval + broadcast ---");
  const sock = makeMockSock();
  const fakeOriginalMsg = {
    key: { remoteJid: "main@g.us", id: "ABC123", fromMe: false },
    message: { imageMessage: { caption: "test photo" } },
  };

  const id = await requestApproval(sock, fakeOriginalMsg, "image", "test photo");
  assert(typeof id === "string" && id.length === 8, "requestApproval returns an 8-char id");
  assert(
    sock.sentMessages.some((m) => m.content.text && m.content.text.includes(id)),
    "approval prompt sent to control chat containing the id"
  );

  await handleControlReply(sock, `YES ${id}`);

  const forwardCalls = sock.sentMessages.filter((m) => m.content.forward);
  assert(forwardCalls.length === 3, `broadcast forwarded to all 3 target groups (got ${forwardCalls.length})`);
  // Note: entry.mediaMessage is round-tripped through the JSON file store, so it's
  // a deep-equal copy of fakeOriginalMsg, not the same object reference.
  assert(
    forwardCalls.every(
      (m) => JSON.stringify(m.content.forward) === JSON.stringify(fakeOriginalMsg) && m.content.force === true
    ),
    "each forward call uses { forward: originalMsg, force: true } (deep-equal to the original message)"
  );
  assert(
    sock.sentMessages.some((m) => m.content.text && /Done\. Sent/.test(m.content.text)),
    "success summary sent to control chat"
  );
}

async function testRejectFlow() {
  console.log("\n--- Test 2: rejection ---");
  const sock = makeMockSock();
  const fakeOriginalMsg = {
    key: { remoteJid: "main@g.us", id: "DEF456", fromMe: false },
    message: { videoMessage: { caption: "" } },
  };

  const id = await requestApproval(sock, fakeOriginalMsg, "video", "");
  await handleControlReply(sock, `NO ${id}`);

  const forwardCalls = sock.sentMessages.filter((m) => m.content.forward);
  assert(forwardCalls.length === 0, "no broadcast sent after rejection");
  assert(
    sock.sentMessages.some((m) => m.content.text && m.content.text.includes("Discarded")),
    "discard confirmation sent"
  );
}

async function testSinglePendingImplicitId() {
  console.log("\n--- Test 3: single pending item, no explicit ID ---");
  const sock = makeMockSock();
  const fakeOriginalMsg = {
    key: { remoteJid: "main@g.us", id: "GHI789", fromMe: false },
    message: { imageMessage: { caption: "" } },
  };
  await requestApproval(sock, fakeOriginalMsg, "image", "");
  await handleControlReply(sock, "yes"); // no id given, should resolve to the sole pending item

  const forwardCalls = sock.sentMessages.filter((m) => m.content.forward);
  assert(forwardCalls.length === 3, "bare 'yes' with a single pending item triggers broadcast");
}

async function testTimeoutExpiry() {
  console.log("\n--- Test 4: timeout expiry ---");
  const sock = makeMockSock();
  const fakeOriginalMsg = {
    key: { remoteJid: "main@g.us", id: "JKL012", fromMe: false },
    message: { imageMessage: { caption: "" } },
  };
  const id = await requestApproval(sock, fakeOriginalMsg, "image", "");
  // Wait longer than APPROVAL_TIMEOUT_MINUTES (~1.2s) for the expiry timer to fire
  await new Promise((r) => setTimeout(r, 2000));

  assert(
    sock.sentMessages.some((m) => m.content.text && m.content.text.includes(`${id} expired`)),
    "expiry message sent after timeout"
  );

  const forwardCalls = sock.sentMessages.filter((m) => m.content.forward);
  assert(forwardCalls.length === 0, "no broadcast sent for an expired request");
}

async function testAmbiguousMultiplePending() {
  console.log("\n--- Test 5: multiple pending, ambiguous reply without ID ---");
  const sock = makeMockSock();
  const msg1 = { key: { remoteJid: "main@g.us", id: "M1", fromMe: false }, message: { imageMessage: {} } };
  const msg2 = { key: { remoteJid: "main@g.us", id: "M2", fromMe: false }, message: { imageMessage: {} } };
  const id1 = await requestApproval(sock, msg1, "image", "");
  const id2 = await requestApproval(sock, msg2, "image", "");

  await handleControlReply(sock, "yes"); // ambiguous — should ask for explicit ID, not broadcast

  const forwardCalls = sock.sentMessages.filter((m) => m.content.forward);
  assert(forwardCalls.length === 0, "ambiguous bare 'yes' with 2 pending items does NOT broadcast");
  assert(
    sock.sentMessages.some((m) => m.content.text && m.content.text.includes("Multiple pending")),
    "asks the user to disambiguate with an explicit ID"
  );

  // Now resolve explicitly
  await handleControlReply(sock, `YES ${id1}`);
  const forwardCallsAfter = sock.sentMessages.filter((m) => m.content.forward);
  assert(forwardCallsAfter.length === 3, "explicit YES <id> resolves correctly even with other pending items");

  // id2 should still be pending
  await handleControlReply(sock, `NO ${id2}`);
}

(async () => {
  try {
    await testApproveFlow();
    await testRejectFlow();
    await testSinglePendingImplicitId();
    await testTimeoutExpiry();
    await testAmbiguousMultiplePending();
    console.log("\n🎉 All dry-run tests passed.");
  } catch (e) {
    console.error("\n💥 Test crashed:", e);
    process.exitCode = 1;
  } finally {
    restore();
    // Give any pending setTimeouts (already-cleared expiry timers) a tick to settle
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
