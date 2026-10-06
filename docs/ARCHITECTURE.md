# Architecture

> This was the original README. It is the long-form design rationale —
> what the system is, how the pieces fit, and why each rule exists.
> The [README](../README.md) is the short version.

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
- **Agent transcripts are private to the person who ran them.** Each run is
  tagged with the actor who started it and only that actor can list or open it;
  the file is written `0600`, because a transcript carries command output and
  file contents and Node's default would leave it readable by every account on
  the machine. How an agent works is private; what it concluded is posted to the
  channel it was asked in. Runs are recorded to `agent-sessions.jsonl` in the
  app's own data directory, never the server — that file also carries each
  channel's Claude Code session id, so a channel keeps one continuous
  conversation across app restarts instead of meeting a stranger.
- **Voice is a mesh, and the ceiling is the sharer's uplink, not the server.**
  The server forwards SDP/ICE and never touches media, so hosting it on a small
  VPS costs nothing for a call. What does not scale is the mesh itself: a
  participant sends their stream once per peer, so a screen share at ~1.5 Mbps
  costs the sharer `(N-1) x 1.5` Mbps upstream — fine at four people, painful
  at six on a home connection. Past roughly five, this wants an SFU.
- **ICE config is served, not hardcoded.** TURN credentials belong to the
  deployment, and a static TURN password in the client bundle is a relay anyone
  can abuse — so `GET /v1/voice/config` mints short-lived HMAC credentials
  (coturn's `use-auth-secret`) per call. Without TURN set, the ~10-20% of pairs
  behind symmetric NAT simply fail to connect; TURN is also the one path where
  media does flow through the VPS.
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
- **Hand the agent one message, not the room.** Any message carries an "Ask
  agent" action: the quoted text and an instruction become the prompt, and the
  message and channel ids go with them so the agent can pull the surrounding
  conversation itself rather than being handed context it may not need. It
  answers in that message's own thread, which keeps a focused exchange out of
  the channel.
- **MCP is pull; the adapter is push.** MCP lets an agent read and write the
  workspace, but nothing wakes it — so `@agent <prompt>` in a thread starts a
  headless Claude Code turn whose transcript is posted back into that thread.
  The agent posts under its *own* identity, never the human's.
- **The laptop keeps its own veto.** A teammate's message starting a shell on
  your machine is remote code execution, so the policy lives on disk in the
  desktop app, defaults to OFF, defaults to owner-only, carries a per-turn
  dollar cap, and grants an explicit tool allowlist (workspace memory plus
  read-only code access — no Bash, Write or Edit until you widen it).
- **The terminal outlives its view.** The pty and a bounded replay buffer live
  in the main process, so a reload reattaches to the same shell and is handed
  the scrollback it missed. A view going away is not a reason to kill a shell;
  only an explicit kill or closing the window is. It is also workbench-level,
  outside the Chat/Apps switch, for the same reason.
- **Two surfaces, one state.** Chat is the narrative; Apps is the workspace.
  A widget inline in a thread is an attachment; the same widget in Apps gets
  the whole canvas. Built-in apps (task board, registry) sit beside
  agent-published ones because to the person using them there is no difference.
  Everything a board does still writes through the log.
- **Widget refresh never touches a model.** A 30s tick re-invokes the tool
  server-side and pushes rows. If refresh cost an inference the feature would be
  unusable at any scale.
- **The conversation is the last thing to give way.** Side panes fold before
  the centre column narrows: project memory becomes a strip under 1150px, the
  thread pane goes under 1150px, and the dock is capped to a fraction of the
  viewport on a short window. Every grid column is `minmax(0, 1fr)` rather than
  `1fr`, because the default refuses to shrink below its content and one wide
  message is enough to push the right-hand panes off the screen.
- **The browser is a first-class surface, not a degraded one.** The same build
  serves both, and the parts that genuinely need a machine — a pty, a local
  agent — say so instead of appearing broken. Chrome adapts rather than
  pretending: the title bar only reserves space for traffic lights where there
  are any (desktop, not fullscreen, never a browser tab), and the dock starts
  collapsed on the web rather than spending 260px explaining itself.
- **The mark in the chrome, the wordmark at the door.** A 57px-wide wordmark
  is unreadable in a 38px title bar, so the chrome carries the chevron alone at
  20px — the size where the three dots stop merging — beside the *workspace*
  name, which is the thing a person actually needs to know there. The full
  wordmark appears on the sign-in screen, where it has room to read.
- **Colour means something; chrome does not.** The brand mark is strictly
  monochrome — 197 greys, no chromatic fill anywhere — so the interface follows
  it: surfaces are the logo's own neutral near-blacks, and "active" or
  "primary" is simply brighter rather than blue. Colour is reserved for
  meaning: purple marks a non-human author, and the status steps
  (good/warning/serious/critical) keep their fixed values. A UI that spends
  colour on decoration has none left for signal.
- **Onboarding is a checklist derived from state, not a wizard with flags.**
  A step is done when the thing it asks for exists — a project summary, a link,
  a decision, an agent token, a second member. It therefore cannot claim you
  have a decision log when you do not, it stays done when a teammate does the
  work, and it can be dismissed without hiding anything real.
- **Credentials are revocable, and that is the point.** A workspace token used
  to be a password that never expired: losing a laptop meant rotating everyone.
  Now people sign in with a password and hold a 30-day session they can list
  and revoke per device; agents and the MCP bridge hold named API tokens
  revocable one at a time. Disabling a person ends their sessions immediately
  *and* disables the agents that act for them — anything less is a half-exit.
- **Four roles, because a small team needs "who can reshape the workspace", not
  a matrix.** guest reads; member writes; admin activates tools and widgets and
  manages people; owner alone changes ownership. A workspace can never be left
  without an active owner, and nobody can disable themselves.
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
| Auth: password sign-in, invites, roles, revocable sessions | ✅ working |
| Voice channels (WebRTC mesh) | ✅ working |
| Screen sharing | ⚠️ built; needs macOS Screen Recording permission |
| Server-side tool registry + embedded live views | ✅ working |
| Apps surface (task board, registry, full-size widgets) | ✅ working |
| Rollups + extraction + pgvector hybrid | ⬜ designed |

## Quickstart

```bash
npm install
npm run db:up          # Postgres 17 + pgvector in Docker (port 5433)
npm run db:migrate
npm run build
npm run dev            # server on :4000, web on :5174
```

Open the app. An empty server offers to create the workspace: name it, pick a
handle and a password, and you are its owner — with an agent identity and
`#general` created alongside. `npm run seed` still exists for scripted setups,
but nobody has to touch a terminal to start.

The endpoint closes itself the moment a workspace exists, so it cannot be used
to mint an account on someone else's server.

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
