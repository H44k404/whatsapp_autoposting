require("dotenv").config({ quiet: true });
const crypto = require("crypto");
const { createUser } = require("../src/auth");
const { query, close } = require("../src/db");

(async () => {
  const suffix = crypto.randomBytes(5).toString("hex");
  const adminPassword = crypto.randomBytes(18).toString("base64url");
  const admin = await createUser({ username: `testadmin_${suffix}`, password: adminPassword, role: "admin" });
  const jar = () => new Map();
  const request = async (cookies, url, options = {}) => {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (cookies.has("connect.sid")) headers.cookie = `connect.sid=${cookies.get("connect.sid")}`;
    if (!options.skipCsrf && ["POST", "PATCH", "PUT", "DELETE"].includes((options.method || "GET").toUpperCase()) && url.startsWith("/api/")) {
      const csrf = await fetch(`http://127.0.0.1:${process.env.TEST_PORT || "3001"}/api/csrf`, { headers: { cookie: headers.cookie || "" } });
      const payload = await csrf.json();
      headers["x-csrf-token"] = payload.token;
    }
    const response = await fetch(`http://127.0.0.1:${process.env.TEST_PORT || "3001"}${url}`, { ...options, headers });
    const cookie = response.headers.get("set-cookie");
    if (cookie) cookies.set("connect.sid", cookie.split(";")[0].split("=")[1]);
    return response;
  };
  const adminCookies = jar();
  const adminLogin = await request(adminCookies, "/auth/login", { method: "POST", body: JSON.stringify({ username: admin.username, password: adminPassword }) });
  const list = await request(adminCookies, "/api/admin/users");
  const csrfRejected = await request(adminCookies, "/api/admin/users", { method: "POST", skipCsrf: true, body: JSON.stringify({ username: `blocked_${suffix}`, password: adminPassword }) });
  const workerPassword = crypto.randomBytes(18).toString("base64url");
  const workerResponse = await request(adminCookies, "/api/admin/users", { method: "POST", body: JSON.stringify({ username: `worker_${suffix}`, password: workerPassword, workspaceName: "Test workspace" }) });
  const worker = await workerResponse.json();
  const workerUser = await query("SELECT id FROM users WHERE username = $1", [worker.username]);
  const adminMe = await (await request(adminCookies, "/api/me")).json();
  const workerCookies = jar();
  const workerLogin = await request(workerCookies, "/auth/login", { method: "POST", body: JSON.stringify({ username: worker.username, password: workerPassword }) });
  const workerMe = await (await request(workerCookies, "/api/me")).json();
  if (adminMe.workspaceId !== "admin") throw new Error("Admin must use the canonical admin workspace.");
  if (!workerMe.workspaceId || workerMe.workspaceId === adminMe.workspaceId) throw new Error("Worker must use a separate workspace.");
  const workerAdminAttempt = await request(workerCookies, "/api/admin/users");
  const disableWorker = await request(adminCookies, `/api/admin/users/${encodeURIComponent(workerUser.rows[0].id)}`, { method: "PATCH", body: JSON.stringify({ isActive: false }) });
  const afterDisable = await request(workerCookies, "/api/status");
  await query("DELETE FROM users WHERE id IN ($1, $2)", [admin.id, workerUser.rows[0].id]);
  console.log(JSON.stringify({ adminLogin: adminLogin.status, adminWorkspace: adminMe.workspaceId, adminList: list.status, csrfRejected: csrfRejected.status, workerCreated: workerResponse.status, workerLogin: workerLogin.status, workerWorkspace: workerMe.workspaceId, workerAdminAttempt: workerAdminAttempt.status, disableWorker: disableWorker.status, afterDisable: afterDisable.status }));
  await close();
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
