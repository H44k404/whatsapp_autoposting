const net = require("net");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const host = "127.0.0.1";
const port = 5433;
const dataDir = path.resolve(__dirname, "../../postgres-data");
const pgCtl = "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe";

function dashboardAlreadyRunning() {
  return new Promise((resolve) => {
    const request = http.get({ host, port: 3000, path: "/login.html", timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => { request.destroy(); resolve(false); });
  });
}

function canConnect() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

function waitForDatabase(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (await canConnect()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`PostgreSQL did not become ready on ${host}:${port}`));
      setTimeout(check, 250);
    };
    check();
  });
}

async function startDatabase() {
  if (await canConnect()) return null;
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
  await waitForDatabase();
  return child;
}

(async () => {
  try {
    if (await dashboardAlreadyRunning()) {
      console.log("Dashboard is already running at http://localhost:3000");
      return;
    }
    await startDatabase();
    require(path.resolve(__dirname, "..", "src", "index.js"));
  } catch (error) {
    console.error(`[startup] ${error.message}`);
    process.exitCode = 1;
  }
})();
