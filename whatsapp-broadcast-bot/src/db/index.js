const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set for the PostgreSQL-backed application.");
}

const pool = new Pool({
  connectionString,
  max: Number.parseInt(process.env.DATABASE_POOL_MAX || "10", 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});

const ready = Promise.resolve();

async function query(text, values) {
  await ready;
  return pool.query(text, values);
}

async function withTransaction(callback) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, ready, query, withTransaction, close };
