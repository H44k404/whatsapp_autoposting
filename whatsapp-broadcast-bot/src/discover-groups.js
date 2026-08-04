/**
 * ONE-TIME SETUP SCRIPT.
 *
 * Run this once to discover the JIDs of every WhatsApp group the bot number
 * is currently a member of. Scan the printed QR code with the BOT's
 * WhatsApp number (Settings → Linked Devices → Link a Device).
 *
 * Usage:
 *   npm run discover-groups
 *
 * Copy the printed "<id> - <subject>" lines into config/groups.json:
 *   - one group id -> "mainGroup"
 *   - ten group ids -> "targetGroups"
 *
 * Also grab the owner's own JID (format countrycode+number@s.whatsapp.net,
 * printed when the owner messages the bot directly) and put it in .env as
 * CONTROL_CHAT_JID.
 *
 * Delete or stop using this script after setup is complete.
 */
require("dotenv").config({ quiet: true });
const { startBot } = require("./whatsapp");
const logger = require("./utils/logger");

startBot((sock) => {
  logger.info("Fetching all groups the bot is currently participating in...");

  (async () => {
    try {
      const list = await sock.groupFetchAllParticipating();
      const groups = Object.values(list);
      if (groups.length === 0) {
        logger.warn("No groups found yet. Make sure the bot's number has been added to your groups.");
      }
      groups.forEach((g) => {
        console.log(`${g.id} - ${g.subject}`);
      });
      logger.info(`Found ${groups.length} group(s). Copy the IDs above into config/groups.json.`);
    } catch (e) {
      logger.error({ err: e }, "Failed to fetch groups");
    }
  })();

  // Also log any NEW groups discovered live (e.g. if you get added to one while this is running)
  sock.ev.on("groups.upsert", (groups) => {
    groups.forEach((g) => console.log(`[new] ${g.id} - ${g.subject}`));
  });

  // Print the JID of any message sender so you can grab the owner's own JID easily
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (from && !from.endsWith("@g.us")) {
        console.log(`[DM] Message from ${from} — if this is the owner's number, use it as CONTROL_CHAT_JID`);
      }
    }
  });
});
