const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");
const { query, withTransaction } = require("./db");

const PASSWORD_COST = Number.parseInt(process.env.BCRYPT_COST || "12", 10);

async function findActiveUser(username) {
  const result = await query(
    "SELECT id, username, password_hash, role FROM users WHERE username = $1 AND is_active = TRUE",
    [username]
  );
  return result.rows[0] || null;
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}

async function createUser({ username, password, role = "worker", workspaceName }) {
  const normalizedUsername = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalizedUsername)) {
    throw new Error("Username must contain 3-64 lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Password must be at least 12 characters long.");
  }
  if (!['admin', 'worker'].includes(role)) throw new Error("Invalid role.");

  const passwordHash = await bcrypt.hash(password, PASSWORD_COST);
  return withTransaction(async (client) => {
    const userId = randomUUID();
    await client.query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
      [userId, normalizedUsername, passwordHash, role]
    );
    await client.query(
      "INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)",
      [randomUUID(), userId, workspaceName || `${normalizedUsername} workspace`]
    );
    return { id: userId, username: normalizedUsername, role };
  });
}

async function getWorkspaceForUser(userId) {
  const result = await query(
    "SELECT id, owner_user_id, name FROM workspaces WHERE owner_user_id = $1",
    [userId]
  );
  return result.rows[0] || null;
}

async function listUsers() {
  const result = await query(
    `SELECT u.id, u.username, u.role, u.is_active, u.created_at, w.name AS workspace_name
     FROM users u LEFT JOIN workspaces w ON w.owner_user_id = u.id
     ORDER BY u.created_at ASC`
  );
  return result.rows;
}

async function setUserActive(userId, isActive) {
  const result = await query(
    "UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, is_active",
    [isActive, userId]
  );
  const user = result.rows[0] || null;
  if (user && !isActive) {
    await query("DELETE FROM session WHERE sess->>'userId' = $1", [String(userId)]);
  }
  return user;
}

async function recordAudit({ userId = null, action, ipAddress = null, metadata = {} }) {
  await query(
    "INSERT INTO audit_logs (user_id, action, ip_address, metadata) VALUES ($1, $2, $3, $4)",
    [userId, action, ipAddress, JSON.stringify(metadata)]
  );
}

module.exports = {
  createUser,
  findActiveUser,
  getWorkspaceForUser,
  listUsers,
  recordAudit,
  setUserActive,
  verifyPassword,
};
