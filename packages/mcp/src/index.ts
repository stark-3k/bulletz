#!/usr/bin/env node
/**
 * bulletz MCP bridge.
 *
 * This is the portable surface: any MCP-speaking agent (Claude Code, Cursor,
 * Zed, Continue, …) gets the workspace's memory and tools through it. Nothing
 * here is vendor-specific on purpose.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Decision, Event, Note, SearchHit, Task, Channel } from "@bulletz/shared";
import { z } from "zod";
import { api, qs } from "./client.js";

const server = new McpServer({ name: "bulletz", version: "0.1.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `bulletz error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/* ------------------------------ read: context ----------------------------- */

server.tool(
  "context_pack",
  "Get what this project knows: what it is and where it lives (repo, deployed URLs, dashboards), durable constraints, current decisions, open work, and optionally a channel's history. CALL THIS FIRST when starting work on an unfamiliar task — it is the project's memory, which the repo does not contain.",
  {
    channel_id: z.string().uuid().optional().describe("Include this channel's recent messages"),
    query: z.string().max(500).optional().describe("Also include context relevant to this topic"),
  },
  async (args) => {
    try {
      const r = await api.get<{ markdown: string }>(
        `/context${qs({ channel_id: args.channel_id, query: args.query, format: "markdown" })}`,
      );
      return text(r.markdown);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "search_context",
  "Search the workspace log, decisions, constraints and tasks. Returns ranked units, each with the source event ids you can drill into. Use for 'why did we…', 'what did we decide about…', 'has anyone touched…'.",
  {
    query: z.string().min(1).max(500),
    channel_id: z.string().uuid().optional(),
    kinds: z.array(z.string()).optional().describe("Restrict to event kinds, e.g. ['message','decision']"),
    since: z.string().optional().describe("ISO timestamp lower bound"),
    limit: z.number().int().min(1).max(50).default(20),
    include_superseded: z.boolean().default(false).describe("Include decisions that have been overruled"),
  },
  async (args) => {
    try {
      const r = await api.post<{ hits: SearchHit[] }>("/search", args);
      if (!r.hits.length) return text("No matches.");
      return text(
        r.hits
          .map((h) => {
            const who = h.actor_handle ? `${h.actor_handle} · ` : "";
            const src = h.source_event_ids.length ? `\n    sources: ${h.source_event_ids.join(", ")}` : "";
            return `[${h.unit}] ${who}${h.created_at.slice(0, 10)} (score ${h.score.toFixed(3)})\n    ${h.text.replace(/\n/g, "\n    ")}${src}`;
          })
          .join("\n\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_channel",
  "Read a conversation channel's events in order.",
  {
    channel_id: z.string().uuid(),
    limit: z.number().int().min(1).max(500).default(100),
  },
  async (args) => {
    try {
      const r = await api.get<{ channel: Channel; events: Event[] }>(
        `/channels/${args.channel_id}/events${qs({ limit: args.limit })}`,
      );
      const lines = r.events.map((e) =>
        e.kind === "message"
          ? `${e.actor_handle}: ${e.body ?? ""}`
          : `(${e.kind}) ${e.actor_handle}: ${e.body ?? ""}`,
      );
      return text(`# ${r.channel.title}\n\n${lines.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_channels",
  "List conversation channels, most recently active first.",
  {},
  async () => {
    try {
      const r = await api.get<{ channels: Channel[] }>("/channels");
      if (!r.channels.length) return text("No channels yet.");
      return text(
        r.channels.map((t) => `${t.id}  ${t.last_event_at.slice(0, 16)}  [${t.status}] ${t.title}`).join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "decisions_for",
  "List the project's decisions. Superseded ones are excluded by default — the current answer is what you want.",
  {
    path: z.string().optional().describe("Only decisions tagged with this file path"),
    channel_id: z.string().uuid().optional(),
    include_superseded: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(30),
  },
  async (args) => {
    try {
      const r = await api.get<{ decisions: Decision[] }>(`/decisions${qs(args)}`);
      if (!r.decisions.length) return text("No decisions recorded.");
      return text(
        r.decisions
          .map((d) => {
            const sup = d.status === "superseded" ? " [SUPERSEDED]" : "";
            const why = d.rationale ? `\n    why: ${d.rationale}` : "";
            return `${d.statement}${sup}\n    id: ${d.id} · ${d.decided_by_handle ?? "?"} · ${d.decided_at.slice(0, 10)}${why}`;
          })
          .join("\n\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

/* ------------------------------ write: report ----------------------------- */

server.tool(
  "post_message",
  "Post a message into a channel so your human teammates can see it. Use this to report what you did, ask a question, or flag something — you are posting under your own agent identity, not impersonating anyone.",
  {
    body: z.string().min(1).max(50_000),
    channel_id: z.string().uuid().optional().describe("Omit and pass channel_title to start a new channel"),
    channel_title: z.string().min(1).max(200).optional(),
    reply_to: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Post as a reply in this message's thread instead of at the top level of the channel. Use it to keep a long exchange out of the main room.",
      ),
    refs: z
      .object({
        paths: z.array(z.string()).optional(),
        prs: z.array(z.string()).optional(),
        tasks: z.array(z.string()).optional(),
      })
      .optional(),
  },
  async (args) => {
    try {
      const r = await api.post<{ event: Event }>("/events", {
        kind: "message",
        body: args.body,
        channel_id: args.channel_id,
        channel_title: args.channel_title,
        reply_to: args.reply_to,
        refs: args.refs ?? {},
      });
      return text(
        `Posted ${args.reply_to ? "as a reply" : "to channel"} ${r.event.channel_id ?? "(none)"} as event ${r.event.id}.`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "record_decision",
  "Record a decision in the project's decision log so future agents and teammates inherit it. If this reverses an earlier decision, pass supersedes_id — that is what keeps the log from contradicting itself.",
  {
    statement: z.string().min(3).max(2000).describe("The decision, stated as a fact: 'We use Postgres, not Dynamo'"),
    rationale: z.string().max(10_000).optional().describe("Why. This is the part that stops it being re-litigated."),
    alternatives: z.array(z.string()).default([]),
    supersedes_id: z.string().uuid().optional(),
    channel_id: z.string().uuid().optional(),
    entities: z
      .object({ paths: z.array(z.string()).optional(), prs: z.array(z.string()).optional() })
      .optional(),
    source_event_ids: z.array(z.string().uuid()).default([]).describe("Events that evidence this decision"),
    confidence: z.number().min(0).max(1).default(1),
  },
  async (args) => {
    try {
      const r = await api.post<{ decision: Decision }>("/decisions", {
        ...args,
        entities: args.entities ?? {},
      });
      return text(`Recorded decision ${r.decision.id}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "record_constraint",
  "Record a durable project rule that must not be violated (as opposed to a point-in-time decision). Example: 'CI status is never cached; always read it live.'",
  {
    rule: z.string().min(3).max(2000),
    rationale: z.string().max(10_000).optional(),
    source_event_ids: z.array(z.string().uuid()).default([]),
  },
  async (args) => {
    try {
      await api.post("/constraints", args);
      return text("Recorded constraint.");
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "create_task",
  "Create a task in the shared workspace.",
  {
    title: z.string().min(3).max(500),
    body: z.string().max(50_000).optional(),
    labels: z.array(z.string()).default([]),
    channel_id: z.string().uuid().optional(),
    assignee_handle: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await api.post<{ task: Task }>("/tasks", args);
      return text(`Created task ${r.task.id}: ${r.task.title}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_tasks",
  "List workspace tasks.",
  {
    status: z.array(z.enum(["open", "in_progress", "blocked", "done", "cancelled"])).optional(),
    labels: z.array(z.string()).optional(),
  },
  async (args) => {
    try {
      const r = await api.get<{ tasks: Task[] }>(
        `/tasks${qs({ status: args.status?.join(","), labels: args.labels?.join(",") })}`,
      );
      if (!r.tasks.length) return text("No tasks.");
      return text(
        r.tasks
          .map((t) => `[${t.status}] ${t.title}${t.labels.length ? ` (${t.labels.join(", ")})` : ""}\n    id: ${t.id}`)
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "update_task",
  "Change a task: its status, title, body or labels. Pass only the fields you want changed.",
  {
    task_id: z.string().uuid(),
    status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional(),
    title: z.string().min(3).max(500).optional(),
    body: z.string().max(50_000).optional(),
    labels: z.array(z.string()).optional(),
  },
  async (args) => {
    const { task_id, ...patch } = args;
    if (Object.keys(patch).length === 0) return text("Nothing to update.");
    try {
      await api.patch(`/tasks/${task_id}`, patch);
      return text(`Updated task ${task_id}: ${Object.keys(patch).join(", ")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "retire_constraint",
  "Retire a project constraint that is wrong or no longer applies. Constraints appear in the 'do not violate' section of every context pack, so a stale one actively misleads. Retiring keeps it in the log but removes it from that section — it is not a delete.",
  { constraint_id: z.string().uuid().describe("From context_pack or list_constraints") },
  async (args) => {
    try {
      await api.patch(`/constraints/${args.constraint_id}`, { status: "retired" });
      return text(`Retired constraint ${args.constraint_id}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_constraints",
  "List the project's active constraints with their ids.",
  {},
  async () => {
    try {
      const r = await api.get<{ constraints: Array<{ id: string; rule: string; rationale: string | null }> }>(
        "/constraints",
      );
      if (!r.constraints.length) return text("No active constraints.");
      return text(
        r.constraints
          .map((c) => `${c.rule}${c.rationale ? `\n    why: ${c.rationale}` : ""}\n    id: ${c.id}`)
          .join("\n\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "remove_project_link",
  "Retire a project link whose URL is wrong or dead. Addressed by its label.",
  { label: z.string().min(1).max(80) },
  async (args) => {
    try {
      await api.del(`/project/links/${encodeURIComponent(args.label)}`);
      return text(`Retired link "${args.label}".`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "report_status",
  "Publish your local machine status to the workspace so teammates can see what this agent is working on. Send only the allowlisted fields below — never file contents.",
  {
    branch: z.string().max(200).optional(),
    cwd: z.string().max(500).optional(),
    dirty_files: z.number().int().min(0).optional(),
    test_status: z.enum(["passing", "failing", "unknown"]).optional(),
    machine: z.string().max(200).optional(),
    agent_kind: z.string().max(100).optional(),
  },
  async (args) => {
    try {
      await api.put("/presence", { ...args, online: true });
      return text("Status published.");
    } catch (e) {
      return fail(e);
    }
  },
);


/* ---------------------------- tools & widgets ---------------------------- */

server.tool(
  "create_tool",
  "Define a workspace tool that runs ON THE SERVER. It is created as a DRAFT and cannot run until a human activates it in the UI — you cannot activate it yourself. Prefer kind 'sql' (a read-only query over the workspace log) since it needs no credentials.",
  {
    name: z.string().min(2).max(64).regex(/^[a-z][a-z0-9_]*$/).describe("lowercase snake_case"),
    description: z.string().min(5).max(1000).describe("What it returns. Written for whoever reads the tool list."),
    impl: z.union([
      z.object({
        kind: z.literal("sql"),
        query: z
          .string()
          .describe(
            "A single read-only SELECT/WITH. $1 is always the workspace id and must appear in the WHERE clause; $2 is a jsonb of the call arguments. Write statements and multiple statements are rejected.",
          ),
      }),
      z.object({
        kind: z.literal("http"),
        method: z.enum(["GET", "POST"]).default("GET"),
        url: z.string().url().describe("May use {{args.name}} and {{secret.NAME}} placeholders"),
        headers: z.record(z.string()).default({}),
      }),
    ]),
    egress_allow: z.array(z.string()).default([]).describe("Required for http tools: bare hostnames this tool may reach"),
  },
  async (args) => {
    try {
      const r = await api.post<{ tool: { id: string; name: string; status: string } }>("/tools", args);
      return text(
        `Drafted tool "${r.tool.name}" (${r.tool.id}).\nIt is a DRAFT and will not run until a human activates it.`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_tools",
  "List the workspace's tools and whether each is active.",
  {},
  async () => {
    try {
      const r = await api.get<{ tools: Array<Record<string, string>> }>("/tools");
      if (!r.tools.length) return text("No tools defined.");
      return text(
        r.tools.map((t) => `[${t.status}] ${t.name} (${t.kind}) — ${t.description}\n    id: ${t.id}`).join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "invoke_tool",
  "Run an active workspace tool and get its rows back.",
  { tool: z.string().describe("Tool name or id"), args: z.record(z.unknown()).default({}) },
  async (a) => {
    try {
      const r = await api.post<{ rows: unknown[]; ms: number }>(`/tools/${a.tool}/invoke`, a.args);
      return text(`${r.rows.length} rows in ${r.ms}ms\n${JSON.stringify(r.rows, null, 2).slice(0, 4000)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "publish_widget",
  "Publish a live UI into the workspace chat. Three kinds:\n• 'view' (preferred) — pick a built-in view type and map your tool's fields to it. Typed, themed, accessible, and it refreshes without costing a model call.\n• 'html' — your own HTML/CSS/JS for what the view types cannot express. It runs in a null-origin sandbox with no credentials and no access to the host page. Do NOT put an <iframe> to a website in here: the null origin is inherited, the site loads without storage, and most pages render blank. Use 'embed' for that.\n• 'embed' — frame a website at `url`. The site loads at its own origin, so it works normally; it is cross-origin from the workspace and cannot read it.\nWidgets are created as DRAFTS; a human activates them.",
  {
    name: z.string().min(2).max(64),
    description: z.string().max(500).optional(),
    kind: z.enum(["view", "html", "embed"]),
    tool: z.string().optional().describe("Name or id of the tool supplying rows (required for 'view')"),
    tool_args: z.record(z.unknown()).default({}),
    view: z
      .object({
        type: z.enum(["metric", "bar", "table", "status_grid"]),
        title: z.string().max(120).optional(),
        value_field: z.string().optional().describe("metric/bar: the numeric field"),
        label_field: z.string().optional().describe("bar/status_grid: the name field"),
        status_field: z.string().optional().describe("status_grid: field holding ok|warn|down"),
        detail_field: z.string().optional().describe("status_grid: small text under each label"),
        unit: z.string().max(16).optional(),
        columns: z.array(z.string()).optional().describe("table: column order"),
        refresh_ms: z.number().int().min(2000).max(600000).optional().describe("Re-fetch interval; never involves a model"),
      })
      .optional(),
    html: z.string().max(400000).optional().describe("kind='html': a full fragment. No network access."),
    url: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe("kind='embed': the http/https page to frame"),
    channel_id: z.string().uuid().optional().describe("Post it into this channel"),
  },
  async (args) => {
    try {
      const r = await api.post<{ widget: { id: string; name: string; status: string } }>("/widgets", args);
      return text(`Published widget "${r.widget.name}" (${r.widget.id}) as a draft. A human can activate it in the UI.`);
    } catch (e) {
      return fail(e);
    }
  },
);


/* -------------------------------- project -------------------------------- */

server.tool(
  "project_info",
  "What this project is and where it lives — summary, repo, deployed URLs, dashboards, docs. These are the coordinates the checkout cannot tell you.",
  {},
  async () => {
    try {
      const p = await api.get<{
        name: string;
        summary: string | null;
        links: Array<{ kind: string; label: string; url: string; notes: string | null }>;
      }>("/project");
      const out = [`# ${p.name}`, p.summary ?? "_No summary recorded._", ""];
      if (p.links.length) {
        out.push("## Where it lives");
        for (const l of p.links) out.push(`- ${l.kind}: ${l.label} — ${l.url}${l.notes ? ` (${l.notes})` : ""}`);
      } else {
        out.push("_No links recorded._");
      }
      return text(out.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "set_project_summary",
  "Describe what this project is, in a paragraph or two, for whoever (human or agent) arrives next. Replaces the existing summary.",
  { summary: z.string().min(10).max(8000) },
  async (args) => {
    try {
      await api.put("/project", args);
      return text("Project summary updated.");
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "add_project_link",
  "Record where part of the project lives — repo, production site, staging, docs, a dashboard. Use for things the checkout cannot reveal. Re-using a label updates that link.",
  {
    kind: z.enum(["repo", "site", "staging", "docs", "dashboard", "tracker", "design", "api", "chat", "other"]),
    label: z.string().min(1).max(80).describe("Short name, unique in the workspace, e.g. 'production'"),
    url: z.string().url().max(2000),
    notes: z.string().max(500).optional(),
  },
  async (args) => {
    try {
      await api.post("/project/links", args);
      return text(`Recorded ${args.kind} link "${args.label}".`);
    } catch (e) {
      return fail(e);
    }
  },
);


server.tool(
  "edit_message",
  "Correct a message you posted. The previous text is kept in the log as a prior revision rather than overwritten, so the record of what was said stays intact. You can only edit your own messages.",
  {
    event_id: z.string().uuid().describe("The event id returned when you posted it, or from get_thread"),
    body: z.string().min(1).max(50_000).describe("The corrected message, in full"),
  },
  async (args) => {
    try {
      await api.patch(`/events/${args.event_id}`, { body: args.body });
      return text("Message edited. The earlier version remains in the log.");
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_message",
  "Retract a message you posted. It stops appearing in the channel and in search, but the event stays in the log for audit — this is a retraction, not an erasure. You can only delete your own messages.",
  { event_id: z.string().uuid() },
  async (args) => {
    try {
      await api.del(`/events/${args.event_id}`);
      return text("Message retracted.");
    } catch (e) {
      return fail(e);
    }
  },
);


server.tool(
  "get_thread",
  "Read one reply thread: the message it hangs off, plus its replies in order.",
  { root_id: z.string().uuid().describe("The id of the message the thread hangs off") },
  async (args) => {
    try {
      const r = await api.get<{ root: Event | null; replies: Event[] }>(`/threads/${args.root_id}`);
      if (!r.root) return text("Thread not found.");
      const line = (e: Event) => `${e.actor_handle}: ${e.body ?? ""}`;
      return text([line(r.root), "--- replies ---", ...r.replies.map(line)].join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

/* ---------------------------------- notes --------------------------------- */

/** Notes are the one unit an agent can both write freely and rewrite. A
 *  decision is a claim, a constraint is a rule, a task is work — a note is the
 *  working document none of those shapes fit: a runbook, an investigation, the
 *  state of a migration halfway through. They are included in search_context,
 *  so what gets written here is what the next agent reads. */
server.tool(
  "list_notes",
  "List the workspace's notes — runbooks, investigations and working documents. Returns ids and a preview; use read_note for the full text.",
  {
    include_archived: z.boolean().default(false),
    labels: z.array(z.string()).optional().describe("Only notes carrying any of these labels"),
  },
  async (args) => {
    try {
      const r = await api.get<{ notes: Note[] }>(
        `/notes${qs({
          include_archived: args.include_archived,
          ...(args.labels?.length ? { labels: args.labels.join(",") } : {}),
        })}`,
      );
      if (!r.notes.length) return text("No notes yet.");
      return text(
        r.notes
          .map((n) => {
            const head = `${n.pinned ? "★ " : ""}${n.title || "(untitled)"}${
              n.status === "archived" ? " [archived]" : ""
            }`;
            const preview = n.body.replace(/\s+/g, " ").slice(0, 180);
            return `${head}\n    id: ${n.id} · ${n.body.length} chars · updated ${n.updated_at}${
              n.updated_by_handle ? ` by ${n.updated_by_handle}` : ""
            }\n    ${preview}${n.body.length > 180 ? "…" : ""}`;
          })
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "read_note",
  "Read one note in full.",
  { note_id: z.string().uuid() },
  async (args) => {
    try {
      // There is no GET /notes/:id — the list endpoint is already indexed on
      // (workspace, status) and a workspace's notes are tens of rows, not
      // thousands. Adding a route for one row is not worth the surface.
      const r = await api.get<{ notes: Note[] }>(`/notes${qs({ include_archived: true })}`);
      const n = r.notes.find((x) => x.id === args.note_id);
      if (!n) return text("Note not found.");
      return text(
        `# ${n.title || "(untitled)"}${n.status === "archived" ? " [archived]" : ""}\n` +
          `id: ${n.id} · updated ${n.updated_at}${n.updated_by_handle ? ` by ${n.updated_by_handle}` : ""}\n\n` +
          n.body,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "write_note",
  "Create a note, or overwrite an existing one. Use for anything worth keeping that is not a decision, a constraint or a task: runbooks, investigation write-ups, setup steps. Pass note_id to replace that note's contents — notes are last-write-wins, so read_note first if you mean to append rather than replace.",
  {
    note_id: z.string().uuid().optional().describe("Omit to create a new note"),
    title: z.string().max(300).optional(),
    body: z.string().max(200_000).optional(),
    labels: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
    channel_id: z.string().uuid().optional().describe("The conversation this note came out of (new notes only)"),
  },
  async (args) => {
    try {
      const { note_id, channel_id, ...fields } = args;
      if (note_id) {
        if (Object.keys(fields).length === 0) {
          return fail(new Error("nothing to update — pass at least one of title, body, labels, pinned"));
        }
        const r = await api.patch<{ note: Note }>(`/notes/${note_id}`, fields);
        return text(`Updated note "${r.note.title || "(untitled)"}" (${r.note.id}).`);
      }
      const r = await api.post<{ note: Note }>("/notes", {
        ...fields,
        ...(channel_id ? { channel_id } : {}),
      });
      return text(
        `Created note "${r.note.title || "(untitled)"}".\nnote id: ${r.note.id}\nIt is live on the Notes app and in search_context immediately — notes need no activation.`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "archive_note",
  "Archive a note (or restore one). Archived notes drop out of the Notes list and out of search_context; the text is kept.",
  {
    note_id: z.string().uuid(),
    restore: z.boolean().default(false).describe("Set true to bring an archived note back"),
  },
  async (args) => {
    try {
      const r = await api.patch<{ note: Note }>(`/notes/${args.note_id}`, {
        status: args.restore ? "active" : "archived",
      });
      return text(`Note "${r.note.title || "(untitled)"}" is now ${r.note.status}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
