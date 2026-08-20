require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required only when running migrations.");

const pool = new Pool({ connectionString: adminUrl, max: 1 });
const schema = fs.readFileSync(path.join(__dirname, "..", "src", "db", "schema.sql"), "utf8");

(async () => {
  try {
    await pool.query(schema);
    console.log("Database migrations applied.");
  } finally {
    await pool.end();
  }
})();
