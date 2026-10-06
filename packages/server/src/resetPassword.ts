/**
 * Last-resort password reset, run on the server box.
 *
 * The in-app reset needs an admin to mint the code, which leaves one case
 * uncovered: the sole owner of a workspace, who has nobody above them. Shell
 * access to the database is the authority here, and that is the right bar —
 * whoever can run this already controls the deployment.
 *
 *   npm run reset-password -- <handle-or-email> [new-password]
 */
import { randomBytes } from "node:crypto";
import { maybeOne, q } from "./db.js";
import { hashPassword } from "./identity.js";
import { pool } from "./db.js";

const [handle, given] = process.argv.slice(2);

if (!handle) {
  console.error("usage: npm run reset-password -- <handle-or-email> [new-password]");
  process.exit(2);
}

const actor = await maybeOne<{ id: string; handle: string; role: string; status: string }>(
  `select id, handle, role, status from actors
    where kind = 'human' and (handle = $1 or lower(email) = lower($1))`,
  [handle],
);

if (!actor) {
  console.error(`no human account matches "${handle}"`);
  process.exit(1);
}

// A generated password is 24 random bytes of base64url — long enough that it
// never needs to be guessable, and it is shown exactly once.
const password = given ?? randomBytes(18).toString("base64url");

await q(`update actors set password_hash = $2, status = 'active' where id = $1`, [
  actor.id,
  await hashPassword(password),
]);
// Whoever held a session under the old password loses it.
await q(`update sessions set revoked_at = now() where actor_id = $1 and revoked_at is null`, [
  actor.id,
]);

console.log(`\n  ${actor.handle} (${actor.role}) — password reset, all sessions revoked`);
if (!given) console.log(`  new password: ${password}`);
console.log("");

await pool.end();
