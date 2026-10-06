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
- **Identity is its own primitive.** A repo URL is not a constraint (a rule you
  must not break) and not a decision (a choice with a rationale, subject to
  supersession) — it is a stable fact about where the project lives. Filing it
  under either would dilute them. The bar for `project_links`: it must *not* be
  derivable from the checkout. The agent has the files; it does not know the
  production URL or which dashboard shows the error budget.
- **Agent transcripts are local, and so is their history.** How an agent works
  is private to the machine that ran it; what it concluded is posted to the
  channel it was asked in. Runs are recorded to `agent-sessions.jsonl` in the
  app's own data directory, never the server — that file also carries each
  channel's Claude Code session id, so a channel keeps one continuous
  conversation across app restarts instead of meeting a stranger.
- **Channels are rooms; threads are branches.** A channel is a durable room.
  A thread hangs off one message inside it (`events.reply_to`), one level deep,
  and the channel shows top-level messages only — so a long exchange lives in
  its thread instead of flooding the room it started in. Reply counts follow
  the HEAD of each reply's revision chain, so editing a reply does not inflate
  the count and deleting one removes it.
- **Edits are events, not mutations.** Editing a message appends a revision
  pointing at the one it replaces; deleting appends a tombstone. Reads resolve
  to the head of the chain, so the thread shows current text while every prior
  version stays in the log — what an agent read at the time is still
  reconstructible. Only the sender may revise their own message. A tombstone
  hides content from every read path but is *not* erasure; real redaction is a
  separate feature.
- **Threads archive, never delete.** An archived thread leaves the sidebar,
  search and context packs — so "deleting" it is real as far as agents are
  concerned — while its events stay in the log and it can be restored. Humans
  only: workspace-level removal is not an agent's call.
- **Memory is revocable, not rewritable.** Decisions are superseded, never
  edited; constraints are retired, never deleted. Both stay in the log — the
  record of what was once believed survives, while only what is currently true
  reaches an agent's context.
- **Agents draft; humans activate.** An agent that can both author and run a
  tool is a privilege-escalation path — untrusted text in a PR body becomes
  "create a tool that exfiltrates, then call it". Tools and widgets are created
  `draft`; activation is refused for any non-human actor (403).
- **MCP is pull; the adapter is push.** MCP lets an agent read and write the
  workspace, but nothing wakes it — so `@agent <prompt>` in a thread starts a
  headless Claude Code turn whose transcript is posted back into that thread.
  The agent posts under its *own* identity, never the human's.
- **The laptop keeps its own veto.** A teammate's message starting a shell on
  your machine is remote code execution, so the policy lives on disk in the
  desktop app, defaults to OFF, defaults to owner-only, carries a per-turn
  dollar cap, and grants an explicit tool allowlist (workspace memory plus
  read-only code access — no Bash, Write or Edit until you widen it).
- **The terminal is workbench-level, never inside a surface.** Unmounting it
  kills its pty, which takes any running job with it, so it lives outside the
  Chat/Apps switch and spans the window like VS Code's panel.
- **Two surfaces, one state.** Chat is the narrative; Apps is the workspace.
  A widget inline in a thread is an attachment; the same widget in Apps gets
  the whole canvas. Built-in apps (task board, registry) sit beside
  agent-published ones because to the person using them there is no difference.
  Everything a board does still writes through the log.
- **Widget refresh never touches a model.** A 30s tick re-invokes the tool
  server-side and pushes rows. If refresh cost an inference the feature would be
  unusable at any scale.
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
| Desktop app (Electron: chat + real pty terminal) | ✅ working |
| Agent adapter — a chat message starts a Claude Code turn | ✅ working |
| Server-side tool registry + embedded live views | ✅ working |
| Apps surface (task board, registry, full-size widgets) | ✅ working |
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
packages/web       the renderer: chat, project memory, terminal pane
packages/desktop   Electron shell: owns the pty and local git status
```

## The desktop app

```bash
npm run dev            # server + web
npm run desktop:rebuild   # once: node-pty against Electron's ABI
npm run dev:desktop
```

The terminal is why this is a desktop app rather than a web app: a real pty
cannot exist in a browser tab. The shell it spawns inherits `BULLETZ_TOKEN` and
opens in the project root, so `claude` started there reaches this workspace
through `.mcp.json` with no further setup — the agent on your machine and the
chat on the server are the same conversation.

`contextIsolation` is on and `nodeIntegration` is off; the renderer's entire
privileged surface is the preload bridge (pty I/O plus an allowlisted local
git status — branch, dirty count, cwd — and never file contents).

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
