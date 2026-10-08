import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { maybeOne, one, q } from "../db.js";
import { appendEvent } from "../repo.js";
import { broadcast } from "../realtime.js";
import { allow, requireActor } from "../authHook.js";
import { ToolError, getTool, invokeTool } from "../tools.js";

const ToolInput = z.object({
  name: z.string().min(2).max(64).regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case"),
  description: z.string().min(5).max(1000),
  input_schema: z.record(z.unknown()).default({ type: "object", properties: {} }),
  impl: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("sql"), query: z.string().min(10).max(8000) }),
    z.object({
      kind: z.literal("http"),
      method: z.enum(["GET", "POST"]).default("GET"),
      url: z.string().url(),
      headers: z.record(z.string()).default({}),
      body: z.unknown().optional(),
    }),
  ]),
  egress_allow: z.array(z.string()).default([]),
});

const ViewSpec = z.object({
  type: z.enum(["metric", "bar", "table", "status_grid"]),
  title: z.string().max(120).optional(),
  // field mappings, by view type
  value_field: z.string().optional(),
  label_field: z.string().optional(),
  status_field: z.string().optional(),
  detail_field: z.string().optional(),
  unit: z.string().max(16).optional(),
  columns: z.array(z.string()).optional(),
  refresh_ms: z.number().int().min(2000).max(600_000).optional(),
});

const WidgetInput = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(500).optional(),
  kind: z.enum(["view", "html", "embed"]),
  tool: z.string().optional(),
  tool_args: z.record(z.unknown()).default({}),
  view: ViewSpec.optional(),
  html: z.string().max(400_000).optional(),
  // A framed site. http/https only: a javascript: or data: URL in a frame is
  // script execution, and "a human activates it" is not a parser.
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:$/.test(new URL(u).protocol), "url must be http or https")
    .optional(),
  channel_id: z.string().uuid().optional(),
});

export async function widgetRoutes(app: FastifyInstance) {
  requireActor(app);

  /* --------------------------------- tools -------------------------------- */

  app.get("/tools", async (req) => ({
    tools: await q(
      `select id, name, description, impl->>'kind' as kind, egress_allow, status,
              created_at, activated_at
         from tools where workspace_id = $1 order by created_at desc`,
      [req.actor.workspace_id],
    ),
  }));

  app.post("/tools", async (req, reply) => {
    if (!allow(req, reply, "write")) return reply;
    const input = ToolInput.parse(req.body);
    if (input.impl.kind === "http" && input.egress_allow.length === 0) {
      return reply.code(400).send({ error: "http tools must declare egress_allow" });
    }
    const tool = await one(
      `insert into tools (workspace_id, name, description, input_schema, impl, egress_allow, created_by)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::text[],$7)
       on conflict (workspace_id, name) do update
         set description = excluded.description, input_schema = excluded.input_schema,
             impl = excluded.impl, egress_allow = excluded.egress_allow,
             status = 'draft', activated_at = null, activated_by = null
       returning id, name, description, status, created_at`,
      [
        req.actor.workspace_id,
        input.name,
        input.description,
        JSON.stringify(input.input_schema),
        JSON.stringify(input.impl),
        input.egress_allow,
        req.actor.id,
      ],
    );
    const event = await appendEvent({
      workspaceId: req.actor.workspace_id,
      channelId: null,
      actorId: req.actor.id,
      kind: "tool_drafted",
      body: `${input.name} — ${input.description}`,
      payload: { tool, kind: input.impl.kind, egress_allow: input.egress_allow },
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return reply.code(201).send({ tool, note: "draft — a human must activate before it can run" });
  });

  // The activation gate. Agents draft; only humans activate.
  app.post("/tools/:id/activate", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Activating a tool widens what every agent in the workspace can do, so it
    // is an admin decision rather than merely a human one.
    if (!allow(req, reply, "activate")) return reply;
    const tool = await maybeOne(
      `update tools set status = 'active', activated_by = $3, activated_at = now()
        where workspace_id = $1 and id = $2 returning id, name, status`,
      [req.actor.workspace_id, id, req.actor.id],
    );
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    const event = await appendEvent({
      workspaceId: req.actor.workspace_id,
      channelId: null,
      actorId: req.actor.id,
      kind: "tool_activated",
      body: (tool as { name: string }).name,
      payload: { tool },
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return { tool };
  });

  /** Delete a tool definition. Unlike a message or a decision, a tool is not
   *  a record of what happened — every invocation is already an event in the
   *  log — so removing the definition loses no history. Humans only, same rule
   *  that gates activation. */
  app.delete("/tools/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!allow(req, reply, "activate")) return reply;
    const used = await q<{ name: string }>(
      `select name from widgets where workspace_id = $1 and tool_id = $2`,
      [req.actor.workspace_id, id],
    );
    if (used.length) {
      return reply
        .code(409)
        .send({ error: `in use by widget(s): ${used.map((w) => w.name).join(", ")}` });
    }
    const tool = await maybeOne<{ name: string }>(
      `delete from tools where workspace_id = $1 and id = $2 returning name`,
      [req.actor.workspace_id, id],
    );
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    const event = await appendEvent({
      workspaceId: req.actor.workspace_id,
      channelId: null,
      actorId: req.actor.id,
      kind: "tool_deleted",
      body: tool.name,
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    return { deleted: tool.name };
  });

  app.post("/tools/:id/invoke", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const args = z.record(z.unknown()).default({}).parse(req.body ?? {});
    const tool = await getTool(req.actor.workspace_id, id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    try {
      const { rows, ms } = await invokeTool(tool, args);
      return { rows, ms, tool: tool.name };
    } catch (err) {
      if (err instanceof ToolError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /* -------------------------------- widgets ------------------------------- */

  app.get("/widgets", async (req) => ({
    widgets: await q(
      `select w.id, w.name, w.description, w.kind, w.tool_id, w.tool_args, w.view, w.url,
              w.status, w.pinned, w.created_at, t.name as tool_name, t.status as tool_status,
              a.handle as created_by_handle
         from widgets w
         left join tools t on t.id = w.tool_id
         left join actors a on a.id = w.created_by
        where w.workspace_id = $1 order by w.created_at desc`,
      [req.actor.workspace_id],
    ),
  }));

  app.post("/widgets", async (req, reply) => {
    if (!allow(req, reply, "write")) return reply;
    const input = WidgetInput.parse(req.body);
    if (input.kind === "view" && !input.view) {
      return reply.code(400).send({ error: "view widgets require a view spec" });
    }
    if (input.kind === "html" && !input.html) {
      return reply.code(400).send({ error: "html widgets require html" });
    }
    if (input.kind === "embed" && !input.url) {
      return reply.code(400).send({ error: "embed widgets require a url" });
    }

    const tool = input.tool ? await getTool(req.actor.workspace_id, input.tool) : null;
    if (input.tool && !tool) return reply.code(404).send({ error: `tool not found: ${input.tool}` });

    const widget = await one(
      `insert into widgets (workspace_id, name, description, kind, tool_id, tool_args, view, html, url, created_by)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
       on conflict (workspace_id, name) do update
         set description = excluded.description, kind = excluded.kind,
             tool_id = excluded.tool_id, tool_args = excluded.tool_args,
             view = excluded.view, html = excluded.html, url = excluded.url,
             status = 'draft'
       returning id, name, description, kind, tool_id, tool_args, view, url, status, pinned, created_at`,
      [
        req.actor.workspace_id,
        input.name,
        input.description ?? null,
        input.kind,
        tool?.id ?? null,
        JSON.stringify(input.tool_args),
        input.view ? JSON.stringify(input.view) : null,
        input.html ?? null,
        input.url ?? null,
        req.actor.id,
      ],
    );

    const event = await appendEvent({
      workspaceId: req.actor.workspace_id,
      channelId: input.channel_id ?? null,
      actorId: req.actor.id,
      kind: "widget",
      body: input.name,
      payload: { widget_id: (widget as { id: string }).id, kind: input.kind },
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    broadcast(req.actor.workspace_id, { type: "widget" });
    return reply.code(201).send({ widget });
  });

  app.post("/widgets/:id/activate", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!allow(req, reply, "activate")) return reply;
    const widget = await maybeOne(
      `update widgets set status = 'active' where workspace_id = $1 and id = $2
       returning id, name, status`,
      [req.actor.workspace_id, id],
    );
    if (!widget) return reply.code(404).send({ error: "widget not found" });
    // Activation is what puts an app in everyone's rail, so it is the moment
    // other windows need to hear about — without this a teammate sees nothing
    // until they reload.
    broadcast(req.actor.workspace_id, { type: "widget" });
    return { widget };
  });

  app.patch("/widgets/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ pinned: z.boolean() }).parse(req.body);
    const widget = await maybeOne(
      `update widgets set pinned = $3 where workspace_id = $1 and id = $2
       returning id, name, pinned`,
      [req.actor.workspace_id, id, body.pinned],
    );
    if (!widget) return reply.code(404).send({ error: "widget not found" });
    return { widget };
  });

  /**
   * Remove a published app.
   *
   * A real delete, not a status flip: a widget is a piece of UI someone put
   * in the workspace, and "I don't want this here any more" should leave
   * nothing behind to explain. The event log still records that it existed
   * and that it went — the row is a current-state table, the log is the
   * history, and deleting from the first does not rewrite the second.
   *
   * Gated on `activate` rather than `write` for the same reason publishing is:
   * agents draft and humans decide what the workspace contains. An agent that
   * could delete widgets could delete the one reporting on it.
   */
  app.delete("/widgets/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!allow(req, reply, "activate")) return reply;
    const widget = await maybeOne<{ id: string; name: string; kind: string }>(
      `delete from widgets where workspace_id = $1 and id = $2 returning id, name, kind`,
      [req.actor.workspace_id, id],
    );
    if (!widget) return reply.code(404).send({ error: "widget not found" });

    const event = await appendEvent({
      workspaceId: req.actor.workspace_id,
      channelId: null,
      actorId: req.actor.id,
      kind: "widget_removed",
      body: widget.name,
      payload: { widget_id: widget.id, kind: widget.kind },
    });
    broadcast(req.actor.workspace_id, { type: "event", event });
    broadcast(req.actor.workspace_id, { type: "widget" });
    return { removed: widget };
  });

  app.get("/widgets/:id/html", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await maybeOne<{ html: string | null }>(
      `select html from widgets where workspace_id = $1 and id = $2`,
      [req.actor.workspace_id, id],
    );
    if (!row) return reply.code(404).send({ error: "widget not found" });
    return { html: row.html ?? "" };
  });

  /** Widget data. The refresh loop calls THIS, not the model — a 30s tick must
   *  never cost an inference. */
  app.get("/widgets/:id/data", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const widget = await maybeOne<{
      tool_id: string | null;
      tool_args: Record<string, unknown>;
      status: string;
    }>(`select tool_id, tool_args, status from widgets where workspace_id = $1 and id = $2`, [
      req.actor.workspace_id,
      id,
    ]);
    if (!widget) return reply.code(404).send({ error: "widget not found" });
    if (!widget.tool_id) return { rows: [], ms: 0 };

    const tool = await getTool(req.actor.workspace_id, widget.tool_id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    try {
      const { rows, ms } = await invokeTool(tool, widget.tool_args);
      return { rows, ms };
    } catch (err) {
      if (err instanceof ToolError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
