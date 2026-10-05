import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, q } from "./db.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

async function main() {
  await q(`create table if not exists _migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await q<{ name: string }>(`select name from _migrations`)).map((r) => r.name));
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(sqlDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(`insert into _migrations (name) values ($1)`, [file]);
      await client.query("commit");
      console.log(`✓ ${file}`);
    } catch (err) {
      await client.query("rollback");
      console.error(`✗ ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
