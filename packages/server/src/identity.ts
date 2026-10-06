import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { maybeOne, one, q } from "./db.js";

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

export type Role = "owner" | "admin" | "member" | "guest";

export type Identity = {
  id: string;
  workspace_id: string;
  kind: "human" | "agent" | "integration";
  handle: string;
  display_name: string;
  owner_actor_id: string | null;
  role: Role;
  status: "active" | "disabled";
  /** How this request authenticated — a browser session or a long-lived token. */
  via: "session" | "api_token" | "legacy";
  sessionId?: string;
};

/* ------------------------------- passwords ------------------------------- */

/** scrypt with a per-password salt. No dependency, and deliberately slow. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  // Constant-time: a length-varying or short-circuiting compare leaks the hash.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* -------------------------------- secrets -------------------------------- */

export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const secret = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

/* -------------------------------- sessions ------------------------------- */

const SESSION_DAYS = 30;

export async function createSession(
  actorId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined },
) {
  const token = secret("blz_s");
  const row = await one<{ id: string; expires_at: string }>(
    `insert into sessions (actor_id, token_hash, user_agent, ip, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
     returning id, expires_at`,
    [actorId, sha256(token), meta.userAgent ?? null, meta.ip ?? null, String(SESSION_DAYS)],
  );
  return { token, ...row };
}

export async function revokeSession(sessionId: string, actorId: string) {
  return maybeOne(
    `update sessions set revoked_at = now()
      where id = $1 and actor_id = $2 and revoked_at is null returning id`,
    [sessionId, actorId],
  );
}

export async function listSessions(actorId: string, currentId?: string | null) {
  // `current` is flagged here rather than compared in the client: the client
  // never sees its own session id, only the opaque token.
  return q(
    `select id, user_agent, ip, created_at, last_used_at, expires_at,
            (id = $2) as current
       from sessions
      where actor_id = $1 and revoked_at is null and expires_at > now()
      order by last_used_at desc nulls last`,
    [actorId, currentId ?? null],
  );
}

/* ------------------------------- resolution ------------------------------ */

const SELECT_ACTOR = `
  a.id, a.workspace_id, a.kind, a.handle, a.display_name,
  a.owner_actor_id, a.role, a.status`;

/** Resolve a bearer token to an identity.
 *
 *  Three credential kinds, checked cheapest-first. A disabled actor resolves
 *  to nothing regardless of which credential it presented — that is what makes
 *  disabling a person actually cut off their agents too. */
export async function identify(token: string): Promise<Identity | null> {
  const hash = sha256(token);

  const session = await maybeOne<Identity & { session_id: string }>(
    `update sessions s set last_used_at = now()
       from actors a
      where s.token_hash = $1 and s.actor_id = a.id
        and s.revoked_at is null and s.expires_at > now()
        and a.status = 'active'
      returning ${SELECT_ACTOR}, s.id as session_id`,
    [hash],
  );
  if (session) return { ...session, via: "session", sessionId: session.session_id };

  const api = await maybeOne<Identity>(
    `update api_tokens t set last_used_at = now()
       from actors a
      where t.token_hash = $1 and t.actor_id = a.id
        and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
        and a.status = 'active'
      returning ${SELECT_ACTOR}`,
    [hash],
  );
  if (api) return { ...api, via: "api_token" };

  // The original scheme: a token stored directly on the actor. Kept so the
  // existing MCP config and desktop app keep working, but it is the one
  // credential that cannot be revoked without rotating the actor.
  const legacy = await maybeOne<Identity>(
    `select ${SELECT_ACTOR} from actors a where a.token_hash = $1 and a.status = 'active'`,
    [hash],
  );
  return legacy ? { ...legacy, via: "legacy" } : null;
}

/* ------------------------------ permissions ------------------------------ */

export const CAPABILITIES = {
  read: ["owner", "admin", "member", "guest"],
  write: ["owner", "admin", "member"],
  /** Changing the shape of the workspace, not just its contents. */
  activate: ["owner", "admin"],
  manage_members: ["owner", "admin"],
  /** Only an owner can hand over or remove ownership. */
  manage_owners: ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export const can = (identity: Identity, capability: Capability): boolean =>
  (CAPABILITIES[capability] as readonly string[]).includes(identity.role);

export { secret };
