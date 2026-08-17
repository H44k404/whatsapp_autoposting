/**
 * Shared group name cache utility
 * Used by both server.js and broadcaster.js to avoid duplicate metadata fetches
 */

const logger = require("./logger");

// Shared cache for group names
const groupNameCache = new Map();

/**
 * Get group name with caching
 * @param {import("@whiskeysockets/baileys").WASocket} sock 
 * @param {string} jid 
 * @returns {Promise<string>} group name or jid fallback
 */
async function getGroupName(sock, jid) {
  if (!jid) return "";
  
  // Check cache first
  if (groupNameCache.has(jid)) {
    return groupNameCache.get(jid);
  }
  
  if (!sock) return jid; // fallback if disconnected
  
  try {
    const meta = await sock.groupMetadata(jid);
    if (meta && meta.subject) {
      groupNameCache.set(jid, meta.subject);
      return meta.subject;
    }
  } catch (e) {
    logger.debug({ err: e.message, jid }, "Could not fetch group metadata");
  }
  
  return jid;
}

/**
 * Pre-populate cache from a list of groups
 * Useful for bulk loading group names
 * @param {import("@whiskeysockets/baileys").WASocket} sock 
 * @param {string[]} jids 
 */
async function preloadGroupNames(sock, jids) {
  if (!sock || !Array.isArray(jids)) return;
  
  try {
    await Promise.all(
      jids
        .filter(jid => !groupNameCache.has(jid))
        .map(jid => getGroupName(sock, jid))
    );
  } catch (e) {
    logger.debug({ err: e.message }, "Error preloading group names");
  }
}

/**
 * Clear the group name cache
 * Useful for testing or forcing a refresh
 */
function clearGroupNameCache() {
  groupNameCache.clear();
}

/**
 * Get cache stats for debugging
 */
function getGroupNameCacheStats() {
  return {
    size: groupNameCache.size,
    entries: Array.from(groupNameCache.entries())
  };
}

module.exports = {
  getGroupName,
  preloadGroupNames,
  clearGroupNameCache,
  getGroupNameCacheStats,
  groupNameCache
};
