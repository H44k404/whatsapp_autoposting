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
process.env.APPROVAL_TIMEOUT_MINUTES = "0.1"; // ~6s, allowing mocked media retries to finish

const path = require("path");
const fs = require("fs");
const { generateWAMessageContent } = require("baileys");

// Use an isolated workspace so the test cannot touch real runtime state.
const DATA_DIR = path.join(__dirname, "..", "data", "workspaces", "dry-run");
const REAL_FILE = path.join(DATA_DIR, "pending_approvals.json");
const BACKUP_FILE = path.join(DATA_DIR, "pending_approvals.json.bak-test");
const BROADCAST_FILE = path.join(DATA_DIR, "broadcast-history.json");
const BROADCAST_BACKUP_FILE = path.join(DATA_DIR, "broadcast-history.json.bak-test");
const PROCESSED_FILE = path.join(DATA_DIR, "processed_source_messages.json");
const PROCESSED_BACKUP_FILE = path.join(DATA_DIR, "processed_source_messages.json.bak-test");
const HAD_REAL_FILE = fs.existsSync(REAL_FILE);
const HAD_BROADCAST_FILE = fs.existsSync(BROADCAST_FILE);
const HAD_PROCESSED_FILE = fs.existsSync(PROCESSED_FILE);
fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(REAL_FILE)) fs.copyFileSync(REAL_FILE, BACKUP_FILE);
if (fs.existsSync(BROADCAST_FILE)) fs.copyFileSync(BROADCAST_FILE, BROADCAST_BACKUP_FILE);
if (fs.existsSync(PROCESSED_FILE)) fs.copyFileSync(PROCESSED_FILE, PROCESSED_BACKUP_FILE);
fs.writeFileSync(REAL_FILE, "{}");
fs.writeFileSync(BROADCAST_FILE, "[]");
fs.writeFileSync(PROCESSED_FILE, "{}");

// Point groups.json at a scratch config
const GROUPS_PATH = path.join(DATA_DIR, "groups.json");
const GROUPS_BACKUP = path.join(DATA_DIR, "groups.json.bak-test");
if (fs.existsSync(GROUPS_PATH)) fs.copyFileSync(GROUPS_PATH, GROUPS_BACKUP);
fs.writeFileSync(
  GROUPS_PATH,
  JSON.stringify({ mainGroup: "main@g.us", targetGroups: ["g1@g.us", "g2@g.us", "g3@g.us"] }, null, 2)
);
process.env.BROADCAST_DELAY_MS = "10"; // speed up the test

const {
  requestApproval,
  handleControlReply,
  isWhatsAppManagementCommand,
  isPrivateControlChat,
  isAuthorizedControlChatSender,
  parseApprovalCommand,
} = require("../src/approval");
const {
  createLinkPreviewMessage,
  extractLinkPreview,
  extractMessageThumbnail,
  isSelfPostedLink,
} = require("../src/utils/linkPreview");

function restore() {
  if (fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(BACKUP_FILE, REAL_FILE);
    fs.unlinkSync(BACKUP_FILE);
  } else if (!HAD_REAL_FILE && fs.existsSync(REAL_FILE)) {
    fs.unlinkSync(REAL_FILE);
  }
  if (fs.existsSync(PROCESSED_BACKUP_FILE)) {
    fs.copyFileSync(PROCESSED_BACKUP_FILE, PROCESSED_FILE);
    fs.unlinkSync(PROCESSED_BACKUP_FILE);
  } else if (!HAD_PROCESSED_FILE && fs.existsSync(PROCESSED_FILE)) {
    fs.unlinkSync(PROCESSED_FILE);
  }
  if (fs.existsSync(BROADCAST_BACKUP_FILE)) {
    fs.copyFileSync(BROADCAST_BACKUP_FILE, BROADCAST_FILE);
    fs.unlinkSync(BROADCAST_BACKUP_FILE);
  } else if (!HAD_BROADCAST_FILE && fs.existsSync(BROADCAST_FILE)) {
    fs.unlinkSync(BROADCAST_FILE);
  }
  if (fs.existsSync(GROUPS_BACKUP)) {
    fs.copyFileSync(GROUPS_BACKUP, GROUPS_PATH);
    fs.unlinkSync(GROUPS_BACKUP);
  } else if (fs.existsSync(GROUPS_PATH)) {
    fs.unlinkSync(GROUPS_PATH);
  }
  if (fs.existsSync(DATA_DIR) && fs.readdirSync(DATA_DIR).length === 0) fs.rmdirSync(DATA_DIR);
}

function makeMockSock() {
  const sentMessages = [];
  const failDeleteJids = new Set();
  return {
    workspaceId: "dry-run",
    sentMessages,
    failDeleteJids,
    sendMessage: async (jid, content) => {
      if (content.delete && failDeleteJids.has(jid)) throw new Error("mock revoke failure");
      sentMessages.push({ jid, content });
      return { key: { id: "mock-" + Math.random().toString(36).slice(2), fromMe: true, remoteJid: jid } };
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

  const {
    COPY_RETENTION_MS,
    getBroadcastHistory,
    recordBroadcastMessage,
    deleteBroadcast,
    autoDeleteExpiredBroadcasts,
  } = require("../src/broadcastHistory");
  const [broadcast] = getBroadcastHistory("dry-run");
  assert(broadcast.groups.length === 3, "successful target copies and their message IDs are saved");
  sock.failDeleteJids.add("g2@g.us");
  const firstDelete = await deleteBroadcast(sock, broadcast.id, "dry-run", "main@g.us");
  assert(firstDelete.deleted === 2 && firstDelete.failed === 1, "partial deletion reports successful and failed target groups");
  assert(
    sock.sentMessages.filter((m) => m.content.delete).every((m) => m.jid !== "main@g.us"),
    "source group is never sent a delete request"
  );
  sock.failDeleteJids.clear();
  const retry = await deleteBroadcast(sock, broadcast.id, "dry-run", "main@g.us");
  assert(retry.deleted === 3 && retry.failed === 0, "failed group deletion can be retried");

  recordBroadcastMessage(
    "auto-cleanup-test",
    "old-copy@g.us",
    "Old copy",
    { key: { id: "old-copy-message", fromMe: true } },
    { mediaType: "image", sourceGroupJid: "main@g.us" },
    "dry-run"
  );
  recordBroadcastMessage(
    "auto-cleanup-test",
    "recent-copy@g.us",
    "Recent copy",
    { key: { id: "recent-copy-message", fromMe: true } },
    { mediaType: "image", sourceGroupJid: "main@g.us" },
    "dry-run"
  );
  const history = JSON.parse(fs.readFileSync(BROADCAST_FILE, "utf-8"));
  const cleanupBroadcast = history.find((item) => item.id === "auto-cleanup-test");
  cleanupBroadcast.groups.find((group) => group.jid === "old-copy@g.us").sentAt = Date.now() - COPY_RETENTION_MS - 1;
  fs.writeFileSync(BROADCAST_FILE, JSON.stringify(history, null, 2));
  const cleanupResults = await autoDeleteExpiredBroadcasts(sock, "dry-run", "main@g.us");
  const cleanupBroadcastAfter = getBroadcastHistory("dry-run").find((item) => item.id === "auto-cleanup-test");
  assert(cleanupResults[0].deleted === 1, "automatic cleanup removes copies older than the retention window");
  assert(
    cleanupBroadcastAfter.groups.find((group) => group.jid === "recent-copy@g.us").status === "sent",
    "automatic cleanup keeps copies within the retention window"
  );
  assert(
    sock.sentMessages.filter((m) => m.content.delete).every((m) => m.jid !== "main@g.us"),
    "automatic cleanup never deletes a source-group message"
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

async function testLinkPreviewFlow() {
  console.log("\n--- Test 3: link preview approval + broadcast ---");
  const sock = makeMockSock();
  const plainLink = extractLinkPreview({
    message: { extendedTextMessage: { text: "See https://example.com/post." } },
  });
  assert(plainLink?.url === "https://example.com/post", "plain URLs are detected even without preview metadata");
  assert(
    extractLinkPreview({ message: { conversation: "https://example.com/plain" } })?.url === "https://example.com/plain",
    "conversation-message URLs are detected without preview metadata"
  );
  const linkThumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const thumbnailMessage = JSON.parse(JSON.stringify({
    message: {
      extendedTextMessage: {
        jpegThumbnail: linkThumbnail,
      },
    },
  }));
  assert(
    extractMessageThumbnail(thumbnailMessage)?.equals(linkThumbnail),
    "link-preview thumbnail is restored from persisted WhatsApp message data"
  );
  assert(
    extractMessageThumbnail({
      message: { extendedTextMessage: { contextInfo: { externalAdReply: { thumbnail: linkThumbnail } } } },
    })?.equals(linkThumbnail),
    "external link-preview thumbnail is detected"
  );

  const fakeOriginalMsg = {
    key: { remoteJid: "main@g.us", id: "LINK123", fromMe: false },
    message: {
      extendedTextMessage: {
        text: "https://www.facebook.com/share/example",
        matchedText: "https://www.facebook.com/share/example",
        canonicalUrl: "https://www.facebook.com/share/example",
        title: "Example post",
        description: "A shared post",
        jpegThumbnail: Buffer.from("preview"),
        thumbnailDirectPath: "/media/thumbnail",
        mediaKey: Buffer.from("media-key"),
        mediaKeyTimestamp: 123,
        thumbnailSha256: Buffer.from("thumbnail-hash"),
        thumbnailEncSha256: Buffer.from("encrypted-thumbnail-hash"),
        thumbnailWidth: 1200,
        thumbnailHeight: 630,
        contextInfo: {
          externalAdReply: {
            title: "Example post",
            mediaType: 2,
            thumbnail: Buffer.from("video preview"),
            renderLargerThumbnail: true,
          },
        },
      },
    },
  };
  const linkPreview = extractLinkPreview(fakeOriginalMsg);
  assert(linkPreview?.title === "Example post", "link title and URL metadata are detected");
  const generatedLinkMessage = await generateWAMessageContent(
    createLinkPreviewMessage(fakeOriginalMsg),
    {}
  );
  assert(
    generatedLinkMessage.extendedTextMessage.thumbnailDirectPath === "/media/thumbnail" &&
      generatedLinkMessage.extendedTextMessage.thumbnailWidth === 1200 &&
      generatedLinkMessage.extendedTextMessage.jpegThumbnail.equals(
        fakeOriginalMsg.message.extendedTextMessage.jpegThumbnail
      ) &&
      generatedLinkMessage.extendedTextMessage.contextInfo.externalAdReply.renderLargerThumbnail,
    "Baileys receives the larger preview metadata and both thumbnail sizes"
  );
  assert(
    isSelfPostedLink({ ...fakeOriginalMsg, key: { ...fakeOriginalMsg.key, fromMe: true } }, "main@g.us"),
    "bot-authored links in the source/approval chat are recognized as self echoes"
  );
  assert(
    !isSelfPostedLink(fakeOriginalMsg, "main@g.us") && !isSelfPostedLink(fakeOriginalMsg, "control@g.us"),
    "links from other senders or chats remain eligible for approval"
  );

  const id = await requestApproval(sock, fakeOriginalMsg, "link", fakeOriginalMsg.message.extendedTextMessage.text);
  const duplicateId = await requestApproval(sock, fakeOriginalMsg, "link", fakeOriginalMsg.message.extendedTextMessage.text);
  assert(duplicateId === null, "repeated delivery of the same WhatsApp message does not create another approval");
  await handleControlReply(sock, `YES ${id}`);

  const linkMessages = sock.sentMessages.filter((m) => m.content.linkPreview);
  assert(linkMessages.length === 4, "fresh link messages are sent to the control chat and all 3 target groups");
  assert(
    linkMessages.every((m) =>
      !m.content.forward &&
      m.content.text === fakeOriginalMsg.message.extendedTextMessage.text &&
      m.content.linkPreview.title === "Example post" &&
      m.content.linkPreview.jpegThumbnail.equals(fakeOriginalMsg.message.extendedTextMessage.jpegThumbnail) &&
      m.content.linkPreview.highQualityThumbnail.directPath === "/media/thumbnail" &&
      m.content.linkPreview.highQualityThumbnail.mediaKey.equals(Buffer.from("media-key"))
    ),
    "fresh link messages preserve preview metadata and thumbnails without a forwarded tag"
  );
  assert(
    sock.sentMessages.some((m) => m.content.text?.includes("New link received") && m.content.text.includes("Example post")),
    "approval prompt identifies the link and its preview title"
  );
}

async function testLinkPreviewWhenSourceIsControlChat() {
  console.log("\n--- Test 4: link approval when source and control chat match ---");
  const groups = JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
  groups.controlChatJid = "main@g.us";
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(groups, null, 2));

  const sock = makeMockSock();
  const url = "https://www.facebook.com/share/source-control";
  const fakeOriginalMsg = {
    key: { remoteJid: "main@g.us", id: "LINK456", fromMe: false },
    message: {
      extendedTextMessage: {
        text: url,
        matchedText: url,
        canonicalUrl: url,
        title: "Same chat preview",
      },
    },
  };

  const id = await requestApproval(sock, fakeOriginalMsg, "link", url);
  const approvalText = sock.sentMessages.find((m) => m.content.text?.includes(`ID: *${id}*`))?.content.text;
  assert(
    !sock.sentMessages.some((m) => m.content.forward),
    "link is not copied back into its source/control group before approval"
  );
  assert(
    approvalText?.includes("original link preview is already visible") && !approvalText.includes(url),
    "approval notice points to the existing preview without repeating the URL"
  );

  await handleControlReply(sock, `YES ${id}`);
  const broadcastPreviews = sock.sentMessages.filter((m) => m.content.linkPreview);
  assert(
    broadcastPreviews.length === 3 &&
      broadcastPreviews.every((m) => m.jid !== "main@g.us" && !m.content.forward),
    "approval sends fresh link previews to target groups without a forwarded tag or source loop"
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
  // Wait longer than APPROVAL_TIMEOUT_MINUTES (~6s) for the expiry timer to fire
  await new Promise((r) => setTimeout(r, 7000));

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

async function testWhatsAppControlCommands() {
  console.log("\n--- Test 6: WhatsApp control commands ---");
  assert(isWhatsAppManagementCommand("/help"), "slash-prefixed management commands are recognized for chat authorization");
  assert(!isWhatsAppManagementCommand("YES a1b2c3d4"), "existing approval replies do not become management commands");
  assert(
    isPrivateControlChat("owner@s.whatsapp.net", "owner@s.whatsapp.net") &&
      !isPrivateControlChat("control@g.us", "control@g.us") &&
      !isPrivateControlChat("other@s.whatsapp.net", "owner@s.whatsapp.net"),
    "private control chat authorization matches only the configured direct chat"
  );
  assert(
    isAuthorizedControlChatSender(
      "control@g.us",
      "control@g.us",
      "owner@s.whatsapp.net",
      "owner@s.whatsapp.net"
    ) &&
      !isAuthorizedControlChatSender(
        "control@g.us",
        "control@g.us",
        "other@s.whatsapp.net",
        "owner@s.whatsapp.net"
      ) &&
      isAuthorizedControlChatSender(
        "control@g.us",
        "control@g.us",
        ["owner@lid", "owner@s.whatsapp.net"],
        "owner@s.whatsapp.net"
      ) &&
      !isAuthorizedControlChatSender("control@g.us", "control@g.us", "owner@s.whatsapp.net", ""),
    "control-group approvals and commands require the configured owner, including its alternate WhatsApp JID"
  );

  const parsed = parseApprovalCommand(
    "/approve a1b2c3d4 groups=1,3 compress=off",
    ["g1@g.us", "g2@g.us", "g3@g.us"]
  );
  assert(
    parsed.id === "a1b2c3d4" &&
      parsed.options.customGroups.join(",") === "g1@g.us,g3@g.us" &&
      parsed.options.compressVideo === false &&
      parsed.options.delayMs === 8000,
    "approval command selects only requested groups and defaults to an 8-second gap"
  );
  assert(
    !!parseApprovalCommand("/approve a1b2c3d4 groups=1 delay=1", ["g1@g.us"]).error,
    "approval command rejects delays shorter than 8 seconds"
  );
  assert(
    !!parseApprovalCommand("/approve a1b2c3d4 groups=1 groups=2", ["g1@g.us", "g2@g.us"]).error,
    "approval command rejects duplicate options"
  );
  assert(
    parseApprovalCommand(
      "/approve a1b2c3d4 groups=all compress=on delay=300",
      ["g1@g.us", "g2@g.us"]
    ).options.compressVideo === true,
    "approval command supports all groups, forced compression, and the maximum safe delay"
  );

  const sock = makeMockSock();
  await handleControlReply(sock, "/groups");
  assert(
    sock.sentMessages.some((message) => message.content.text?.includes("1. g1@g.us")),
    "groups command lists configured destinations with selectable indexes"
  );

  const original = {
    key: { remoteJid: "main@g.us", id: "COMMAND-APPROVAL", fromMe: false },
    message: { imageMessage: { caption: "selected group test" } },
  };
  const approvalId = await requestApproval(sock, original, "image", "selected group test");
  await handleControlReply(sock, `/approve ${approvalId} groups=2 compress=off`);

  const sends = sock.sentMessages.filter((message) => message.content.forward);
  assert(
    sends.length === 1 && sends[0].jid === "g2@g.us",
    "WhatsApp approval command broadcasts only to the explicitly selected group"
  );

  const { getBroadcastHistory } = require("../src/broadcastHistory");
  const broadcast = getBroadcastHistory("dry-run").find((item) => item.approvalId === approvalId);
  assert(!!broadcast, "WhatsApp-triggered broadcast is recorded in the existing sent history");

  await handleControlReply(sock, "/sent");
  assert(
    sock.sentMessages.some((message) => message.content.text?.includes(broadcast.id)),
    "sent command shows the tracked broadcast ID"
  );

  await handleControlReply(sock, `/delete ${broadcast.id}`);
  assert(
    !sock.sentMessages.some((message) => message.content.delete),
    "delete command asks for confirmation without deleting immediately"
  );
  await handleControlReply(sock, `/confirm-delete ${broadcast.id}`);
  const deletionCalls = sock.sentMessages.filter((message) => message.content.delete);
  assert(
    deletionCalls.length === 1 && deletionCalls[0].jid === "g2@g.us",
    "confirmed deletion removes only the tracked destination copy"
  );
  await handleControlReply(sock, `/confirm-delete ${broadcast.id}`);
  assert(
    sock.sentMessages.filter((message) => message.content.delete).length === 1,
    "delete confirmation is single-use"
  );
}

(async () => {
  try {
    await testApproveFlow();
    await testRejectFlow();
    await testLinkPreviewFlow();
    await testLinkPreviewWhenSourceIsControlChat();
    await testSinglePendingImplicitId();
    await testTimeoutExpiry();
    await testAmbiguousMultiplePending();
    await testWhatsAppControlCommands();
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
