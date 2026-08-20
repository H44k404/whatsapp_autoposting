require("dotenv").config({ quiet: true });

const { close } = require("../src/db");
const { createUser } = require("../src/auth");

(async () => {
  try {
    const username = String(process.env.BOOTSTRAP_ADMIN_USERNAME || "").trim().toLowerCase();
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!username || !password) {
      throw new Error("Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD; no default credentials are permitted.");
    }
    const user = await createUser({ username, password, role: "admin", workspaceName: `${username} workspace` });
    console.log(`Created admin account: ${user.username}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await close();
  }
})();
