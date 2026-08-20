require("dotenv").config({ quiet: true });
const db = require("../src/db");

db.ready
  .then(async () => {
    console.log((await db.query("select current_user, current_database()" )).rows);
    await db.close();
  })
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
