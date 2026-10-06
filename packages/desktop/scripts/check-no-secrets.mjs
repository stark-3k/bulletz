/**
 * Refuse to ship a build that carries a credential.
 *
 * The first packaged build embedded a real API token, because Vite loads
 * .env.local in every mode including production. That is a one-line mistake
 * with a bad blast radius — the artifact is the thing you hand to other
 * people — so it is checked rather than remembered.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const DIST = join(REPO, "packages", "web", "dist");

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html|map)$/.test(name)) files.push(p);
  }
};
if (!existsSync(DIST)) {
  console.error("check-no-secrets: no web build to check");
  process.exit(1);
}
walk(DIST);

// Every credential this app mints is prefixed; see identity.ts secret().
const PATTERNS = [
  [/blz_s_[A-Za-z0-9_-]{20,}/g, "a session token"],
  [/blz_t_[A-Za-z0-9_-]{20,}/g, "an API token"],
  [/blz_i_[A-Za-z0-9_-]{20,}/g, "an invite code"],
  [/blz_r_[A-Za-z0-9_-]{20,}/g, "a password-reset code"],
];

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [re, what] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      hits.push({ file: file.replace(REPO + "/", ""), what, sample: `${m[0].slice(0, 12)}…` });
    }
  }
}

if (hits.length) {
  console.error("\ncheck-no-secrets: REFUSING TO PACKAGE — the web build contains credentials:\n");
  for (const h of hits) console.error(`  ${h.what} (${h.sample}) in ${h.file}`);
  console.error("\nBuild with `--mode package`, which strips VITE_BULLETZ_TOKEN.\n");
  process.exit(1);
}

console.log(`check-no-secrets: clean (${files.length} files scanned)`);
