require("dotenv").config({ quiet: true });
const readline = require("readline");
const { createUser } = require("../src/auth");
const { close } = require("../src/db");

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
      input.question(question, (answer) => {
        input.close();
        resolve(answer.trim());
      });
      return;
    }

    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    let answer = "";
    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", onData);
        input.close();
        process.stdout.write("\n");
        resolve(answer);
      } else if (char === "\u0003") {
        process.exit(130);
      } else if (char === "\u007f") {
        answer = answer.slice(0, -1);
      } else {
        answer += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

(async () => {
  try {
    const username = (process.env.BOOTSTRAP_ADMIN_USERNAME || await ask("Admin username: ")).trim().toLowerCase();
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || await ask("Admin password (hidden): ", true);
    const user = await createUser({ username, password, role: "admin", workspaceName: `${username} workspace` });
    console.log(`Created admin account: ${user.username}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await close();
  }
})();
