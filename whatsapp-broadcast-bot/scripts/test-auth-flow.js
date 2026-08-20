require("dotenv").config({ quiet: true });
const crypto = require("crypto");
const { createUser } = require("../src/auth");
const { query, close } = require("../src/db");

(async () => {
  const username = `test_${crypto.randomBytes(6).toString("hex")}`;
  const password = crypto.randomBytes(18).toString("base64url");
  const user = await createUser({ username, password, role: "worker" });
  const cookieJar = new Map();
  const request = async (url, options = {}) => {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (cookieJar.has("connect.sid")) headers.cookie = `connect.sid=${cookieJar.get("connect.sid")}`;
    const response = await fetch(`http://127.0.0.1:${process.env.TEST_PORT || "3000"}${url}`, { ...options, headers });
    const cookie = response.headers.get("set-cookie");
    if (cookie) cookieJar.set("connect.sid", cookie.split(";")[0].split("=")[1]);
    return response;
  };
  const login = await request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  const status = await request("/api/status");
  const csrf = await request("/api/csrf");
  const csrfPayload = await csrf.json();
  const logout = await request("/auth/logout", { method: "POST", headers: { "x-csrf-token": csrfPayload.token }, body: "{}" });
  const afterLogout = await request("/api/status");
  await query("DELETE FROM users WHERE id = $1", [user.id]);
  console.log(JSON.stringify({ login: login.status, authenticatedApi: status.status, logout: logout.status, afterLogout: afterLogout.status }));
  await close();
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
