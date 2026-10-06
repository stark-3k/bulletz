import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { maybeOne, one, q } from "../db.js";
import { requireActor } from "../authHook.js";
import {
  can,
  createSession,
  hashPassword,
  listSessions,
  revokeSession,
  secret,
  sha256,
  verifyPassword,
} from "../identity.js";

const INVITE_HOURS = 72;

export async function authRoutes(app: FastifyInstance) {
  /* ---------------------------- unauthenticated --------------------------- */

  app.post("/auth/login", async (req, reply) => {
    const body = z
      .object({ handle: z.string().min(1).max(80), password: z.string().min(1).max(200) })
      .parse(req.body);

    const actor = await maybeOne<{ id: string; password_hash: string | null; status: string }>(
      `select id, password_hash, status from actors
        where kind = 'human' and (handle = $1 or lower(email) = lower($1))`,
      [body.handle],
    );
    // One message for every failure: distinguishing "no such user" from "wrong
    // password" hands an attacker a way to enumerate accounts.
    const ok = actor?.status === "active" && (await verifyPassword(body.password, actor.password_hash));
    if (!ok) return reply.code(401).send({ error: "invalid handle or password" });

    const session = await createSession(actor!.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    return { token: session.token, expires_at: session.expires_at };
  });

  /** Accept an invite: this is how a person gets an account at all. */
  app.post("/auth/accept", async (req, reply) => {
    const body = z
      .object({
        code: z.string().min(8).max(200),
        handle: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i, "letters, digits, . _ -"),
        display_name: z.string().min(1).max(80).optional(),
        email: z.string().email().max(200).optional(),
        password: z.string().min(10).max(200),
      })
      .parse(req.body);

    const invite = await maybeOne<{ id: string; workspace_id: string; role: string }>(
      `select id, workspace_id, role from invites
        where code_hash = $1 and accepted_at is null and revoked_at is null and expires_at > now()`,
      [sha256(body.code)],
    );
    if (!invite) return reply.code(400).send({ error: "invite is invalid, used, or expired" });

    const taken = await maybeOne(
      `select 1 from actors where workspace_id = $1 and handle = $2`,
      [invite.workspace_id, body.handle],
    );
    if (taken) return reply.code(409).send({ error: "that handle is taken" });

    const actor = await one<{ id: string }>(
      `insert into actors (workspace_id, kind, handle, display_name, email, role, password_hash)
       values ($1, 'human', $2, $3, $4, $5, $6) returning id`,
      [
        invite.workspace_id,
        body.handle,
        body.display_name ?? body.handle,
        body.email ?? null,
        invite.role,
        await hashPassword(body.password),
      ],
    );
    await q(`update invites set accepted_by = $2, accepted_at = now() where id = $1`, [
      invite.id,
      actor.id,
    ]);

    const session = await createSession(actor.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    return reply.code(201).send({ token: session.token, expires_at: session.expires_at });
  });

  /* ----------------------------- authenticated ---------------------------- */

  await app.register(async (secured) => {
    requireActor(secured);

    secured.post("/auth/logout", async (req) => {
      if (req.actor.sessionId) await revokeSession(req.actor.sessionId, req.actor.id);
      return { ok: true };
    });

    secured.get("/auth/sessions", async (req) => ({ sessions: await listSessions(req.actor.id) }));

    secured.delete("/auth/sessions/:id", async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const gone = await revokeSession(id, req.actor.id);
      if (!gone) return reply.code(404).send({ error: "session not found" });
      return { ok: true };
    });

    secured.post("/auth/password", async (req, reply) => {
      const body = z
        .object({ current: z.string().max(200).optional(), next: z.string().min(10).max(200) })
        .parse(req.body);
      const me = await one<{ password_hash: string | null }>(
        `select password_hash from actors where id = $1`,
        [req.actor.id],
      );
      // A set password can only be replaced by someone who knows it: a stolen
      // session must not be enough to lock the real owner out.
      if (me.password_hash && !(await verifyPassword(body.current ?? "", me.password_hash))) {
        return reply.code(403).send({ error: "current password is wrong" });
      }
      await q(`update actors set password_hash = $2 where id = $1`, [
        req.actor.id,
        await hashPassword(body.next),
      ]);
      // Changing a password ends every other session; this one survives.
      await q(
        `update sessions set revoked_at = now()
          where actor_id = $1 and revoked_at is null and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')`,
        [req.actor.id, req.actor.sessionId ?? null],
      );
      return { ok: true };
    });

    /* -------------------------------- members ------------------------------- */

    secured.get("/members", async (req) => ({
      members: await q(
        `select a.id, a.handle, a.display_name, a.email, a.kind, a.role, a.status,
                a.owner_actor_id, a.created_at,
                (select count(*) from sessions s
                  where s.actor_id = a.id and s.revoked_at is null and s.expires_at > now())::int
                  as active_sessions
           from actors a where a.workspace_id = $1 order by a.kind, a.created_at`,
        [req.actor.workspace_id],
      ),
    }));

    secured.post("/invites", async (req, reply) => {
      if (!can(req.actor, "manage_members")) {
        return reply.code(403).send({ error: "only an admin can invite people" });
      }
      const body = z
        .object({ role: z.enum(["admin", "member", "guest"]).default("member"), note: z.string().max(200).optional() })
        .parse(req.body ?? {});
      const code = secret("blz_i");
      const invite = await one<{ id: string; expires_at: string }>(
        `insert into invites (workspace_id, code_hash, role, note, created_by, expires_at)
         values ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)
         returning id, expires_at`,
        [req.actor.workspace_id, sha256(code), body.role, body.note ?? null, req.actor.id, String(INVITE_HOURS)],
      );
      // The only time the code is ever visible. It is stored hashed.
      return reply.code(201).send({ id: invite.id, code, role: body.role, expires_at: invite.expires_at });
    });

    secured.get("/invites", async (req, reply) => {
      if (!can(req.actor, "manage_members")) return reply.code(403).send({ error: "forbidden" });
      return {
        invites: await q(
          `select i.id, i.role, i.note, i.created_at, i.expires_at, i.accepted_at,
                  a.handle as accepted_by_handle
             from invites i left join actors a on a.id = i.accepted_by
            where i.workspace_id = $1 and i.revoked_at is null
            order by i.created_at desc`,
          [req.actor.workspace_id],
        ),
      };
    });

    secured.delete("/invites/:id", async (req, reply) => {
      if (!can(req.actor, "manage_members")) return reply.code(403).send({ error: "forbidden" });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const gone = await maybeOne(
        `update invites set revoked_at = now()
          where id = $1 and workspace_id = $2 and accepted_at is null and revoked_at is null
          returning id`,
        [id, req.actor.workspace_id],
      );
      if (!gone) return reply.code(404).send({ error: "invite not found or already used" });
      return { ok: true };
    });

    secured.patch("/members/:id", async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          role: z.enum(["owner", "admin", "member", "guest"]).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        })
        .refine((v) => Object.keys(v).length > 0, "nothing to change")
        .parse(req.body);

      if (!can(req.actor, "manage_members")) return reply.code(403).send({ error: "forbidden" });

      const target = await maybeOne<{ id: string; role: string; kind: string }>(
        `select id, role, kind from actors where id = $1 and workspace_id = $2`,
        [id, req.actor.workspace_id],
      );
      if (!target) return reply.code(404).send({ error: "member not found" });

      // Only an owner may create or unseat an owner — otherwise an admin could
      // promote themselves past the person who invited them.
      if ((target.role === "owner" || body.role === "owner") && !can(req.actor, "manage_owners")) {
        return reply.code(403).send({ error: "only an owner can change ownership" });
      }
      if (target.id === req.actor.id && body.status === "disabled") {
        return reply.code(400).send({ error: "you cannot disable yourself" });
      }
      // A workspace with no active owner cannot be administered again.
      if (target.role === "owner" && (body.role !== undefined || body.status === "disabled")) {
        const others = await maybeOne<{ n: number }>(
          `select count(*)::int as n from actors
            where workspace_id = $1 and role = 'owner' and status = 'active' and id <> $2`,
          [req.actor.workspace_id, target.id],
        );
        if ((others?.n ?? 0) === 0) {
          return reply.code(409).send({ error: "a workspace must keep at least one active owner" });
        }
      }

      const member = await one(
        `update actors set role = coalesce($3, role), status = coalesce($4, status)
          where id = $1 and workspace_id = $2
          returning id, handle, role, status`,
        [id, req.actor.workspace_id, body.role ?? null, body.status ?? null],
      );
      // Disabling someone must end their access now, not when their session
      // expires — and it takes their agents with them.
      if (body.status === "disabled") {
        await q(`update sessions set revoked_at = now() where actor_id = $1 and revoked_at is null`, [id]);
        await q(
          `update actors set status = 'disabled' where owner_actor_id = $1 and status = 'active'`,
          [id],
        );
      }
      return { member };
    });

    /* ------------------------------ api tokens ------------------------------ */

    secured.get("/api-tokens", async (req) => ({
      tokens: await q(
        `select t.id, t.name, t.created_at, t.last_used_at, t.expires_at, a.handle as actor_handle
           from api_tokens t join actors a on a.id = t.actor_id
          where t.actor_id = $1 or a.owner_actor_id = $1
          order by t.created_at desc`,
        [req.actor.id],
      ),
    }));

    secured.post("/api-tokens", async (req, reply) => {
      const body = z
        .object({ name: z.string().min(1).max(80), actor_id: z.string().uuid().optional() })
        .parse(req.body);
      // You may mint a token for yourself, or for an agent that acts for you.
      const target = body.actor_id
        ? await maybeOne<{ id: string }>(
            `select id from actors
              where id = $1 and workspace_id = $2 and (id = $3 or owner_actor_id = $3)`,
            [body.actor_id, req.actor.workspace_id, req.actor.id],
          )
        : { id: req.actor.id };
      if (!target) return reply.code(403).send({ error: "not your actor" });

      const token = secret("blz_t");
      const row = await one<{ id: string }>(
        `insert into api_tokens (actor_id, name, token_hash, created_by)
         values ($1, $2, $3, $4) returning id`,
        [target.id, body.name, sha256(token), req.actor.id],
      );
      return reply.code(201).send({ id: row.id, name: body.name, token });
    });

    secured.delete("/api-tokens/:id", async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const gone = await maybeOne(
        `update api_tokens t set revoked_at = now()
           from actors a
          where t.id = $1 and t.actor_id = a.id and t.revoked_at is null
            and (t.actor_id = $2 or a.owner_actor_id = $2)
          returning t.id`,
        [id, req.actor.id],
      );
      if (!gone) return reply.code(404).send({ error: "token not found" });
      return { ok: true };
    });
  });
}
