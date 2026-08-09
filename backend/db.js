

require("dotenv").config();
const { DBSQLClient } = require("@databricks/sql");

async function connectDB() {
  const client = new DBSQLClient();

  try {
    console.log("Step 1: Connecting...");

    await client.connect({
      host: process.env.DATABRICKS_HOST,
      path: process.env.DATABRICKS_PATH,
      token: process.env.DATABRICKS_TOKEN
    });

    console.log("Step 2: Connected");

    const session = await client.openSession();

    console.log("Step 3: Session opened");

    return session;

  } catch (err) {
    console.error(err);
    throw err;
  }
}

module.exports = connectDB;