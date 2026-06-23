import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for db:migrate");
}

const pool = new Pool({ connectionString: databaseUrl });
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "schema.sql");
const schema = await readFile(schemaPath, "utf8");

try {
  await pool.query(schema);
  console.log("Database schema is ready");
} finally {
  await pool.end();
}
