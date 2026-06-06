const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

(async () => {
  const host = process.env.DB_HOST || "localhost";
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER || "root";
  const password = process.env.DB_PASS || "";
  const dbname = process.env.DB_NAME || "robloxmcp";

  process.stderr.write(`[db:setup] connecting ${user}@${host}:${port}\n`);

  const conn = await mysql.createConnection({
    host, port, user, password,
    multipleStatements: true,
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbname}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${dbname}\``);
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await conn.query(schema);
  process.stderr.write(`[db:setup] schema applied to \`${dbname}\` @ ${host}:${port}\n`);
  await conn.end();
})().catch((e) => {
  process.stderr.write(`[db:setup] FAILED: ${e.message}\n`);
  process.exit(1);
});
