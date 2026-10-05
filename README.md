# bulletz

**The context layer for local coding agents.**

A hosted workspace that gives every developer's local coding agent the team's
shared memory, tools, and a place to report back — vendor-neutral, over MCP.

Local coding agents see your files perfectly and your project not at all: not
what was decided last month, not why that cache was removed, not what a
teammate's agent just changed. And their reasoning dies in a scrollback nobody
else reads. `bulletz` is the server that holds the project's memory, and the
bridge that hands it to whatever agent each person runs.

## Architecture

```
┌─ server (hosted, collaborative, system of record) ────────┐
│  ① THE LOG    append-only events: chat, tool calls,       │
│               decisions, CI, file edits                   │
│               + retrieval: tsvector → decisions →         │
│                 rollups → hybrid vectors                  │
│  ② THE TOOLS  server-executed, credentialed,              │
│               user-authorable + live embedded views        │
└───────────────────────────┬───────────────────────────────┘
                            │ WebSocket
┌───────────────────────────┴───────────────────────────────┐
│  ③ THE BRIDGE   desktop app / MCP server                  │
└───────────────────────────┬───────────────────────────────┘
                            │ MCP (open protocol)
        Claude Code · Cursor · Zed · Continue · anything
```

**The log is the system of record. Everything else is a projection.** An agent's
context is a replayable *query* over the log, not a synced copy of it.

### Design rules, and why

- **Append-only.** Events are never updated or deleted, so any context an agent
  saw can be reconstructed and audited.
- **Supersession is load-bearing.** A decision log that returns March's choice
  and September's reversal with equal weight makes agents confidently wrong.
  `decisions.supersedes_id` exists so retrieval can default to what is *current*.
- **Extraction beats summarization.** A thread summary is mush. Typed
  `decisions` and `project_constraints` rows are queryable, citable, and
  individually invalidatable.
- **Retrieval is model-free.** It runs on every agent turn, so it is Postgres
  full-text search plus metadata filters — no inference on the hot path, and the
  product works with no API key at all.
- **Rollups are a cache, never truth.** Every derived unit carries
  `source_event_ids` so a caller can always drill back to raw events.
- **Live state is never stored.** CI status, PR mergeability, deploy health are
  tool reads. Caching them means serving stale facts.
- **Agents get their own identity.** An agent acts *for* a human
  (`actors.owner_actor_id`) but posts under its own handle. Nobody reading a
  thread has to guess whether a human wrote it.

## Status

| Component | State |
|---|---|
| Postgres schema (log, decisions, constraints, tasks, rollups, presence) | ✅ working |
| REST API + WebSocket fanout | ✅ working |
| Retrieval: ranked union search + context packs | ✅ working |
| MCP bridge — 12 tools, any MCP client | ✅ working |
| Desktop app (Electron: chat + terminal + embedded MCP) | ⬜ next |
| Server-side tool registry + live views | ⬜ designed |
| Rollups + extraction + pgvector hybrid | ⬜ designed |

## Quickstart

```bash
npm install
npm run db:up          # Postgres 17 + pgvector in Docker (port 5433)
npm run db:migrate
npm run seed -w @bulletz/server     # prints a human token and an agent token
npm run build
npm run dev:server     # http://127.0.0.1:4000
```

Put the agent token in your environment, then any MCP client can mount the
bridge. For Claude Code, `.mcp.json` in this repo already does it:

```bash
export BULLETZ_TOKEN=blz_a_...      # from the seed output
claude                              # 12 bulletz tools now available
```

### The thesis test

The whole product rests on one falsifiable claim: **an agent with workspace
context outperforms the same agent without it.** Test it before building
anything else.

1. Record a handful of real decisions and constraints for a project you know —
   by hand, via `record_decision` / `record_constraint`.
2. Ask an agent *without* the bridge to make a change that those decisions bear
   on.
3. Ask an agent *with* the bridge the same thing. Have it call `context_pack`
   first.

If the second doesn't visibly beat the first, the automated extraction and
summarization layers will not save it. Stop and rethink.

## MCP tools

| Tool | Purpose |
|---|---|
| `context_pack` | **Call first.** Constraints + current decisions + open work + thread history in one shot |
| `search_context` | Ranked search across log, decisions, constraints, tasks — with source event ids |
| `get_thread` / `list_threads` | Read conversations |
| `decisions_for` | Current decisions, superseded ones excluded by default |
| `post_message` | Report back into a thread under the agent's own identity |
| `record_decision` | Write to the decision log, with `supersedes_id` for reversals |
| `record_constraint` | Record a durable rule |
| `create_task` / `list_tasks` / `update_task` | Shared task state |
| `report_status` | Publish allowlisted local state (branch, dirty count, test status) — never file contents |

## Layout

```
packages/shared    types + zod schemas shared by every package
packages/server    Fastify + Postgres: the log, projections, retrieval, realtime
packages/mcp       the portable bridge — stdio MCP server over the HTTP API
```

## Deliberately not built

- **An agent runtime.** Claude Code, Cursor and Aider are better than anything
  we would write, and they bring their own models and billing. The platform
  never makes an inference call, which is the strongest anti-lock-in property
  available.
- **Multi-agent orchestration.** Each agent's own subagent mechanism handles it.
- **Mirroring Linear/GitHub.** We are the system of record for decisions and
  tasks; everything else is a live tool read.
- **Required server-side inference.** Summarization and embeddings are opt-in
  per workspace: `none → local → hosted`.
