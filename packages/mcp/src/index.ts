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
import type { Decision, Event, SearchHit, Task, Thread } from "@bulletz/shared";
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
  "Get what this project knows: durable constraints, current decisions, open work, and optionally a thread's history. CALL THIS FIRST when starting work on an unfamiliar task — it is the project's memory, which the repo does not contain.",
  {
    thread_id: z.string().uuid().optional().describe("Include this thread's recent messages"),
    query: z.string().max(500).optional().describe("Also include context relevant to this topic"),
  },
  async (args) => {
    try {
      const r = await api.get<{ markdown: string }>(
        `/context${qs({ thread_id: args.thread_id, query: args.query, format: "markdown" })}`,
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
    thread_id: z.string().uuid().optional(),
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
  "get_thread",
  "Read a conversation thread's events in order.",
  {
    thread_id: z.string().uuid(),
    limit: z.number().int().min(1).max(500).default(100),
  },
  async (args) => {
    try {
      const r = await api.get<{ thread: Thread; events: Event[] }>(
        `/threads/${args.thread_id}/events${qs({ limit: args.limit })}`,
      );
      const lines = r.events.map((e) =>
        e.kind === "message"
          ? `${e.actor_handle}: ${e.body ?? ""}`
          : `(${e.kind}) ${e.actor_handle}: ${e.body ?? ""}`,
      );
      return text(`# ${r.thread.title}\n\n${lines.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_threads",
  "List conversation threads, most recently active first.",
  {},
  async () => {
    try {
      const r = await api.get<{ threads: Thread[] }>("/threads");
      if (!r.threads.length) return text("No threads yet.");
      return text(
        r.threads.map((t) => `${t.id}  ${t.last_event_at.slice(0, 16)}  [${t.status}] ${t.title}`).join("\n"),
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
    thread_id: z.string().uuid().optional(),
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
  "Post a message into a thread so your human teammates can see it. Use this to report what you did, ask a question, or flag something — you are posting under your own agent identity, not impersonating anyone.",
  {
    body: z.string().min(1).max(50_000),
    thread_id: z.string().uuid().optional().describe("Omit and pass thread_title to start a new thread"),
    thread_title: z.string().min(1).max(200).optional(),
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
        thread_id: args.thread_id,
        thread_title: args.thread_title,
        refs: args.refs ?? {},
      });
      return text(`Posted to thread ${r.event.thread_id ?? "(none)"} as event ${r.event.id}.`);
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
    thread_id: z.string().uuid().optional(),
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
    thread_id: z.string().uuid().optional(),
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
  "Change a task's status.",
  {
    task_id: z.string().uuid(),
    status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]),
  },
  async (args) => {
    try {
      await api.patch(`/tasks/${args.task_id}`, { status: args.status });
      return text(`Task ${args.task_id} → ${args.status}`);
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

const transport = new StdioServerTransport();
await server.connect(transport);
