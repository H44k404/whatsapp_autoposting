const { Pool } = require("pg");
const { spawn } = require("child_process");
const { execFileSync } = require("child_process");
const path = require("path");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set for the PostgreSQL-backed application.");
}

function ensureLocalDatabase() {
  if (process.platform !== "win32" || process.env.NODE_ENV === "production" || !connectionString.includes("127.0.0.1:5433")) return;

  const host = "127.0.0.1";
  const port = "5433";
  const dataDir = path.resolve(__dirname, "../../../postgres-data");
  const pgCtl = "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe";
  const pgIsReady = "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_isready.exe";
  const ready = () => {
    try {
      execFileSync(pgIsReady, ["-h", host, "-p", port], { stdio: "ignore", timeout: 1000 });
      return true;
    } catch (_) {
      return false;
    }
  };

  if (ready()) return;
  const child = spawn(pgCtl, [
    "start",
    "-D", dataDir,
    "-o", `-p ${port} -h ${host}`,
    "-w",
    "-s",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    creationFlags: 0x08000000,
  });
  child.unref();

  const deadline = Date.now() + 15000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`PostgreSQL did not become ready on ${host}:${port}`);
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 250)"], { stdio: "ignore" });
  }
}

ensureLocalDatabase();

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
