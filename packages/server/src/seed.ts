import { randomBytes } from "node:crypto";
import { hashToken } from "./auth.js";
import { maybeOne, one, pool, q } from "./db.js";

/** Creates a workspace, a human actor, and an agent actor that acts for them.
 *  Prints the tokens; they are not recoverable afterwards (only hashes stored). */
async function main() {
  const slug = process.env.SEED_WORKSPACE ?? "bulletz";
  const humanHandle = process.env.SEED_HANDLE ?? "dev";

  const existing = await maybeOne<{ id: string }>(`select id from workspaces where slug = $1`, [slug]);
  const ws = existing
    ? existing
    : await one<{ id: string }>(
        `insert into workspaces (slug, name) values ($1, $2) returning id`,
        [slug, slug],
      );

  const humanToken = `blz_h_${randomBytes(24).toString("base64url")}`;
  const agentToken = `blz_a_${randomBytes(24).toString("base64url")}`;

  const human = await one<{ id: string }>(
    `insert into actors (workspace_id, kind, handle, display_name, token_hash)
     values ($1,'human',$2,$3,$4)
     on conflict (workspace_id, handle) do update set token_hash = excluded.token_hash
     returning id`,
    [ws.id, humanHandle, humanHandle, hashToken(humanToken)],
  );

  await q(
    `insert into actors (workspace_id, kind, handle, display_name, owner_actor_id, token_hash)
     values ($1,'agent',$2,$3,$4,$5)
     on conflict (workspace_id, handle) do update set token_hash = excluded.token_hash`,
    [ws.id, `agent-${humanHandle}`, `Agent (${humanHandle})`, human.id, hashToken(agentToken)],
  );

  console.log(`\nworkspace   ${slug}  (${ws.id})`);
  console.log(`human       ${humanHandle}`);
  console.log(`  token     ${humanToken}`);
  console.log(`agent       agent-${humanHandle}`);
  console.log(`  token     ${agentToken}`);
  console.log(`\nAdd to .env:\n  BULLETZ_TOKEN=${agentToken}\n`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
