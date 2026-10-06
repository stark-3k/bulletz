import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { maybeOne, one, q } from "../db.js";
import { requireActor } from "../authHook.js";
import { can, createSession, hashPassword, secret, sha256 } from "../identity.js";

/**
 * First run, and what to do next.
 *
 * Creating the first workspace used to mean running a seed script from a
 * terminal — fine for the person who wrote it, a dead end for anyone else.
 */
export async function bootstrapRoutes(app: FastifyInstance) {
  /** Unauthenticated by necessity: there is nobody to authenticate as yet. */
  app.get("/bootstrap", async () => {
    const row = await maybeOne<{ n: number }>(`select count(*)::int as n from workspaces`);
    return { needsSetup: (row?.n ?? 0) === 0 };
  });

  app.post("/bootstrap", async (req, reply) => {
    const body = z
      .object({
        workspace: z.string().min(2).max(80),
        handle: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i, "letters, digits, . _ -"),
        display_name: z.string().min(1).max(80).optional(),
        email: z.string().email().max(200).optional(),
        password: z.string().min(10).max(200),
      })
      .parse(req.body);

    // The one-shot guard: once a workspace exists this endpoint is closed, or
    // it would be an open door to create an account on someone else's server.
    const existing = await maybeOne<{ n: number }>(`select count(*)::int as n from workspaces`);
    if ((existing?.n ?? 0) > 0) {
      return reply.code(409).send({ error: "this server is already set up" });
    }

    const slug = body.workspace
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "workspace";

    const ws = await one<{ id: string }>(
      `insert into workspaces (slug, name) values ($1, $2) returning id`,
      [slug, body.workspace],
    );
    const owner = await one<{ id: string }>(
      `insert into actors (workspace_id, kind, handle, display_name, email, role, password_hash)
       values ($1, 'human', $2, $3, $4, 'owner', $5) returning id`,
      [ws.id, body.handle, body.display_name ?? body.handle, body.email ?? null, await hashPassword(body.password)],
    );
    // Every person gets an agent identity from the start, so the agent's work
    // never has to be posted under a human's name.
    await one(
      `insert into actors (workspace_id, kind, handle, display_name, owner_actor_id, role)
       values ($1, 'agent', $2, $3, $4, 'member') returning id`,
      [ws.id, `agent-${body.handle}`, `Agent (${body.handle})`, owner.id],
    );
    await one(
      `insert into channels (workspace_id, title, created_by) values ($1, $2, $3) returning id`,
      [ws.id, "#general", owner.id],
    );

    const session = await createSession(owner.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    return reply.code(201).send({ token: session.token, expires_at: session.expires_at });
  });

  /* ------------------------------ what's next ----------------------------- */

  await app.register(async (secured) => {
    requireActor(secured);

    /** Setup state derived from the workspace itself, not a stored checklist.
     *  A step is done when the thing it asks for exists — so it cannot drift
     *  from reality, and it stays done if someone else does it. */
    secured.get("/onboarding", async (req) => {
      const ws = req.actor.workspace_id;
      const [project, links, decisions, constraints, members, tokens, agent] = await Promise.all([
        maybeOne<{ summary: string | null }>(`select summary from workspaces where id = $1`, [ws]),
        maybeOne<{ n: number }>(
          `select count(*)::int as n from project_links where workspace_id = $1 and status = 'active'`,
          [ws],
        ),
        maybeOne<{ n: number }>(
          `select count(*)::int as n from decisions where workspace_id = $1 and status = 'accepted'`,
          [ws],
        ),
        maybeOne<{ n: number }>(
          `select count(*)::int as n from project_constraints where workspace_id = $1 and status = 'active'`,
          [ws],
        ),
        maybeOne<{ n: number }>(
          `select count(*)::int as n from actors where workspace_id = $1 and kind = 'human' and status = 'active'`,
          [ws],
        ),
        maybeOne<{ n: number }>(
          `select count(*)::int as n from api_tokens t join actors a on a.id = t.actor_id
            where a.owner_actor_id = $1 and t.revoked_at is null`,
          [req.actor.id],
        ),
        maybeOne<{ id: string; handle: string }>(
          `select id, handle from actors where owner_actor_id = $1 and kind = 'agent' limit 1`,
          [req.actor.id],
        ),
      ]);

      return {
        role: req.actor.role,
        agent: agent ?? null,
        steps: {
          describe: { done: Boolean(project?.summary) },
          links: { done: (links?.n ?? 0) > 0, count: links?.n ?? 0 },
          decide: { done: (decisions?.n ?? 0) > 0, count: decisions?.n ?? 0 },
          constrain: { done: (constraints?.n ?? 0) > 0, count: constraints?.n ?? 0 },
          connect: { done: (tokens?.n ?? 0) > 0 },
          invite: { done: (members?.n ?? 0) > 1, count: members?.n ?? 0 },
        },
      };
    });

    /** Mint the agent credential and hand back a ready-to-paste MCP config —
     *  the step most likely to lose someone, because it spans two apps. */
    secured.post("/onboarding/agent-token", async (req, reply) => {
      if (!can(req.actor, "write")) return reply.code(403).send({ error: "forbidden" });
      const agent = await maybeOne<{ id: string; handle: string }>(
        `select id, handle from actors where owner_actor_id = $1 and kind = 'agent' limit 1`,
        [req.actor.id],
      );
      if (!agent) return reply.code(404).send({ error: "no agent identity for this account" });

      const token = secret("blz_t");
      await q(
        `insert into api_tokens (actor_id, name, token_hash, created_by) values ($1, $2, $3, $4)`,
        [agent.id, `${req.actor.handle}'s agent`, sha256(token), req.actor.id],
      );
      return reply.code(201).send({ token, agent_handle: agent.handle });
    });
  });
}
