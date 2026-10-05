import { createHash } from "node:crypto";
import type { Actor } from "@bulletz/shared";
import { maybeOne } from "./db.js";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Resolves a bearer token to an actor. Agents get their own actor row, so the
 *  log always records whether a human or an agent did something. */
export async function actorForToken(token: string): Promise<Actor | null> {
  return maybeOne<Actor>(
    `select id, workspace_id, kind, handle, display_name, owner_actor_id
       from actors where token_hash = $1`,
    [hashToken(token)],
  );
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}
