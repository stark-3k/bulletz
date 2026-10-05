import {
  CreateConstraintInput,
  CreateDecisionInput,
  CreateTaskInput,
  PostEventInput,
  PresenceInput,
  SearchInput,
} from "@bulletz/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireActor } from "../authHook.js";
import { maybeOne, q } from "../db.js";
import * as repo from "../repo.js";
import { broadcast } from "../realtime.js";
import { contextPack, renderContextPack, search } from "../search.js";

export async function apiRoutes(app: FastifyInstance) {
  // Every route below is authenticated as an actor; the log always knows who.
  requireActor(app);

  app.get("/me", async (req) => ({ actor: req.actor }));

  /* ------------------------------- project ------------------------------- */

  app.get("/project", async (req) => await repo.getProject(req.actor.workspace_id));

  app.put("/project", async (req) => {
    const body = z.object({ summary: z.string().min(10).max(8000) }).parse(req.body);
    const project = await repo.setProjectSummary(req.actor.workspace_id, body.summary);
    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: null,
      actorId: req.actor.id,
      kind: "project_summary",
      body: body.summary.slice(0, 500),
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return { project };
  });

  app.post("/project/links", async (req, reply) => {
    const body = z
      .object({
        kind: z.enum(["repo", "site", "staging", "docs", "dashboard", "tracker", "design", "api", "chat", "other"]),
        label: z.string().min(1).max(80),
        url: z.string().url().max(2000),
        notes: z.string().max(500).optional(),
      })
      .parse(req.body);
    const link = await repo.upsertProjectLink({
      workspaceId: req.actor.workspace_id,
      kind: body.kind,
      label: body.label,
      url: body.url,
      notes: body.notes,
      createdBy: req.actor.id,
    });
    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: null,
      actorId: req.actor.id,
      kind: "project_link",
      body: `${body.kind}: ${body.label}`,
      payload: { link },
      refs: { urls: [body.url] },
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return reply.code(201).send({ link });
  });

  app.delete("/project/links/:label", async (req, reply) => {
    const { label } = z.object({ label: z.string() }).parse(req.params);
    const link = await repo.retireProjectLink(req.actor.workspace_id, decodeURIComponent(label));
    if (!link) return reply.code(404).send({ error: "link not found" });
    return { link };
  });

  /* ------------------------------- threads ------------------------------- */

  app.get("/threads", async (req) => ({
    threads: await repo.listThreads(req.actor.workspace_id),
  }));

  app.post("/threads", async (req, reply) => {
    const body = z.object({ title: z.string().min(1).max(200) }).parse(req.body);
    const thread = await repo.createThread(req.actor.workspace_id, body.title, req.actor.id);
    broadcast(req.actor.workspace_id, { type: "thread", thread });
    return reply.code(201).send({ thread });
  });

  app.get("/threads/:id/events", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.string().optional() })
      .parse(req.query);
    const thread = await repo.getThread(req.actor.workspace_id, id);
    if (!thread) return reply.code(404).send({ error: "thread not found" });
    return {
      thread,
      events: await repo.threadEvents(req.actor.workspace_id, id, {
        limit: query.limit,
        beforeSeq: query.before,
      }),
    };
  });

  /* -------------------------------- events ------------------------------- */

  app.get("/events", async (req) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return { events: await repo.recentEvents(req.actor.workspace_id, query.limit) };
  });

  app.post("/events", async (req, reply) => {
    const input = PostEventInput.parse(req.body);

    let threadId = input.thread_id ?? null;
    if (!threadId && input.thread_title) {
      const thread = await repo.createThread(req.actor.workspace_id, input.thread_title, req.actor.id);
      broadcast(req.actor.workspace_id, { type: "thread", thread });
      threadId = thread.id;
    }
    if (threadId) {
      const exists = await repo.getThread(req.actor.workspace_id, threadId);
      if (!exists) return reply.code(404).send({ error: "thread not found" });
    }

    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId,
      actorId: req.actor.id,
      kind: input.kind,
      body: input.body,
      payload: input.payload,
      refs: input.refs,
      labels: input.labels,
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return reply.code(201).send({ event });
  });

  /** Edit. Appends a revision rather than mutating: the prior text stays in
   *  the log, so what an agent read at the time is still reconstructible.
   *  Only the original sender may revise their own message. */
  app.patch("/events/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ body: z.string().min(1).max(100_000) }).parse(req.body);

    const head = await repo.eventHead(req.actor.workspace_id, id);
    if (!head) return reply.code(404).send({ error: "event not found" });
    if (head.actor_id !== req.actor.id) {
      return reply.code(403).send({ error: "only the sender can edit this message" });
    }
    if (head.kind === "message_deleted") {
      return reply.code(409).send({ error: "message was deleted" });
    }
    if (head.kind !== "message") {
      return reply.code(400).send({ error: `only messages are editable (this is ${head.kind})` });
    }

    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: head.thread_id,
      actorId: req.actor.id,
      kind: "message",
      body: body.body,
      revisionOf: head.id,
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return { event };
  });

  /** Delete. A tombstone revision, not an erasure: the row survives for audit.
   *  Real redaction (overwriting the stored text) is a separate feature. */
  app.delete("/events/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const head = await repo.eventHead(req.actor.workspace_id, id);
    if (!head) return reply.code(404).send({ error: "event not found" });
    if (head.actor_id !== req.actor.id) {
      return reply.code(403).send({ error: "only the sender can delete this message" });
    }
    if (head.kind === "message_deleted") return { event: null, already: true };

    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: head.thread_id,
      actorId: req.actor.id,
      kind: "message_deleted",
      body: null,
      revisionOf: head.id,
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return { event };
  });

  /* ------------------------------ decisions ------------------------------ */

  app.get("/decisions", async (req) => {
    const query = z
      .object({
        include_superseded: z.coerce.boolean().default(false),
        thread_id: z.string().uuid().optional(),
        path: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return {
      decisions: await repo.listDecisions(req.actor.workspace_id, {
        includeSuperseded: query.include_superseded,
        threadId: query.thread_id,
        path: query.path,
        limit: query.limit,
      }),
    };
  });

  app.post("/decisions", async (req, reply) => {
    const input = CreateDecisionInput.parse(req.body);
    const decision = await repo.createDecision({
      workspaceId: req.actor.workspace_id,
      threadId: input.thread_id ?? null,
      statement: input.statement,
      rationale: input.rationale,
      alternatives: input.alternatives,
      status: input.status,
      supersedesId: input.supersedes_id,
      entities: input.entities,
      sourceEventIds: input.source_event_ids,
      confidence: input.confidence,
      decidedBy: req.actor.id,
    });

    // A decision is also an event: the log stays the complete record.
    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: input.thread_id ?? null,
      actorId: req.actor.id,
      kind: "decision",
      body: input.statement,
      payload: { decision_id: decision.id, rationale: input.rationale ?? null },
      refs: input.entities,
    });

    broadcast(req.actor.workspace_id, { type: "decision", decision });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return reply.code(201).send({ decision });
  });

  /* ----------------------------- constraints ----------------------------- */

  app.get("/constraints", async (req) => ({
    constraints: await repo.listConstraints(req.actor.workspace_id),
  }));

  app.post("/constraints", async (req, reply) => {
    const input = CreateConstraintInput.parse(req.body);
    const constraint = await repo.createConstraint({
      workspaceId: req.actor.workspace_id,
      rule: input.rule,
      rationale: input.rationale,
      sourceEventIds: input.source_event_ids,
      createdBy: req.actor.id,
    });
    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: null,
      actorId: req.actor.id,
      kind: "constraint",
      body: input.rule,
      payload: { constraint },
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return reply.code(201).send({ constraint });
  });

  app.patch("/constraints/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ status: z.literal("retired") }).parse(req.body);
    const constraint = await repo.retireConstraint(req.actor.workspace_id, id);
    if (!constraint) return reply.code(404).send({ error: "active constraint not found" });
    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: null,
      actorId: req.actor.id,
      kind: "constraint_retired",
      body: constraint.rule,
      payload: { constraint_id: constraint.id, status: body.status },
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return { constraint };
  });

  /* -------------------------------- tasks -------------------------------- */

  app.get("/tasks", async (req) => {
    const query = z
      .object({
        status: z.string().optional(),
        labels: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    return {
      tasks: await repo.listTasks(req.actor.workspace_id, {
        status: query.status?.split(",").filter(Boolean),
        labels: query.labels?.split(",").filter(Boolean),
        limit: query.limit,
      }),
    };
  });

  app.post("/tasks", async (req, reply) => {
    const input = CreateTaskInput.parse(req.body);
    const assignee = input.assignee_handle
      ? await maybeOne<{ id: string }>(
          `select id from actors where workspace_id = $1 and handle = $2`,
          [req.actor.workspace_id, input.assignee_handle],
        )
      : null;

    const task = await repo.createTask({
      workspaceId: req.actor.workspace_id,
      threadId: input.thread_id ?? null,
      title: input.title,
      body: input.body,
      labels: input.labels,
      assigneeId: assignee?.id ?? null,
      createdBy: req.actor.id,
    });
    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: input.thread_id ?? null,
      actorId: req.actor.id,
      kind: "task_created",
      body: input.title,
      payload: { task_id: task.id },
      refs: { tasks: [task.id] },
    });
    broadcast(req.actor.workspace_id, { type: "task", task });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return reply.code(201).send({ task });
  });

  app.patch("/tasks/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional(),
        title: z.string().min(3).max(500).optional(),
        body: z.string().max(50_000).optional(),
        labels: z.array(z.string()).optional(),
      })
      .refine((v) => Object.keys(v).length > 0, "nothing to update")
      .parse(req.body);
    const task = await repo.updateTask(req.actor.workspace_id, id, body);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const event = await repo.appendEvent({
      workspaceId: req.actor.workspace_id,
      threadId: task.thread_id,
      actorId: req.actor.id,
      kind: "task_updated",
      body: body.status ? `${task.title} → ${body.status}` : `${task.title} (edited)`,
      payload: { task_id: task.id, ...body },
      refs: { tasks: [task.id] },
    });
    broadcast(req.actor.workspace_id, { type: "task", task });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return { task };
  });

  /* ------------------------------ retrieval ------------------------------ */

  app.post("/search", async (req) => {
    const input = SearchInput.parse(req.body);
    return { hits: await search(req.actor.workspace_id, input) };
  });

  app.get("/context", async (req) => {
    const query = z
      .object({
        thread_id: z.string().uuid().optional(),
        query: z.string().max(500).optional(),
        format: z.enum(["json", "markdown"]).default("json"),
      })
      .parse(req.query);
    const pack = await contextPack(req.actor.workspace_id, {
      thread_id: query.thread_id,
      query: query.query,
    });
    if (query.format === "markdown") return { markdown: renderContextPack(pack) };
    return pack;
  });

  /* ------------------------------- presence ------------------------------ */

  app.put("/presence", async (req) => {
    const input = PresenceInput.parse(req.body);
    await q(
      `insert into agent_presence (actor_id, workspace_id, machine, cwd, branch,
                                   dirty_files, test_status, agent_kind, online, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       on conflict (actor_id) do update set
         machine = excluded.machine, cwd = excluded.cwd, branch = excluded.branch,
         dirty_files = excluded.dirty_files, test_status = excluded.test_status,
         agent_kind = excluded.agent_kind, online = excluded.online, updated_at = now()`,
      [
        req.actor.id,
        req.actor.workspace_id,
        input.machine ?? null,
        input.cwd ?? null,
        input.branch ?? null,
        input.dirty_files ?? null,
        input.test_status ?? null,
        input.agent_kind ?? null,
        input.online,
      ],
    );
    broadcast(req.actor.workspace_id, {
      type: "presence",
      actor_handle: req.actor.handle,
      online: input.online,
    });
    return { ok: true };
  });

  app.get("/presence", async (req) => ({
    presence: await q(
      `select a.handle, a.kind, a.display_name, p.machine, p.cwd, p.branch,
              p.dirty_files, p.test_status, p.agent_kind, p.online, p.updated_at
         from agent_presence p join actors a on a.id = p.actor_id
        where p.workspace_id = $1 order by p.updated_at desc`,
      [req.actor.workspace_id],
    ),
  }));
}
