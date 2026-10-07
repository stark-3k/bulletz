<div align="center">

<img src="packages/web/public/logo.svg" alt="bulletz.ai" width="300">

**The context layer for local coding agents.**

Your team's shared memory, tools, and a place to report back — for whichever coding agent each person already runs.

</div>

---

## What this is

Every developer on a team now runs a coding agent locally. Each one starts from nothing: no idea what the team decided last week, what constraints are in force, or what anyone else is doing right now. Each one finishes in a terminal nobody else sees.

Bulletz is a self-hosted workspace that fixes both ends. It holds the chat, the decisions, the constraints, the tasks, and the notes — and exposes them to any agent over **MCP**. The agent reads the team's context before it works, and posts its result back into the channel under **its own identity**, not yours.

It is deliberately **not** an agent runtime. Your agent keeps running on your laptop, with your model, your subscription, your files. Claude Code, Cursor, Zed — anything that speaks MCP. Bulletz never sees your code and never runs your model.

```
   your laptop                     the server (your VPS)
┌─────────────────┐            ┌──────────────────────────┐
│  coding agent   │◀──  MCP  ──▶│  event log · decisions   │
│  terminal       │            │  constraints · tasks     │
│  your files     │            │  notes · channels        │
└─────────────────┘            └──────────────────────────┘
                                          ▲
                                     teammates
```

## Why it's built this way

**An append-only event log is the system of record.** Chat, decisions, constraints and tasks are projections over it. An agent's context is a *query*, not a synced copy that drifts.

**Nothing is mutated; things are superseded.** Decisions supersede, constraints retire, messages tombstone through revision chains, channels archive. You can always ask what the team believed on a given day.

**Agents have their own identity.** An agent actor is owned by a human actor but posts under its own handle. The agent's work never reads as if a person wrote it — that distinction is enforced at the token level, not by convention.

**Retrieval is model-free on the hot path.** Postgres `tsvector` plus metadata filters. No inference call per agent turn, so context retrieval is free and instant.

**Tools and widgets are draft-until-activated.** An agent can propose a tool; a human has to turn it on. Prompt injection cannot escalate into a live integration.

**Agent transcripts are private by default.** Runs stream to a local JSONL scoped to the owning actor at `0600`. The agent decides what to post; its reasoning is not broadcast to the channel.

The full design rationale — every rule and the reasoning behind it — is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What's in the box

| | |
|---|---|
| **Channels & threads** | Real reply threads, edit and delete via revision chains, archiving |
| **Project memory** | Summary, links, decisions with supersession, constraints, tasks |
| **Notes** | Long-form prose the narrow shapes don't fit — runbooks, investigations |
| **Search** | Full-text across events, decisions, constraints and notes |
| **MCP bridge** | `context_pack`, `get_channel`, `create_task`, `post_message`, and more |
| **Local terminal** | A real pty in the desktop app, pre-wired with the workspace token |
| **Chat-triggered agents** | `@agent` in a channel runs your local agent, under machine-local policy |
| **Voice & screen share** | WebRTC full mesh, server relays signalling only |
| **Custom widgets** | Agent-authored HTML apps, embedded in chat or pinned to a board |
| **Auth** | Roles, invites, revocable sessions and API tokens, admin-issued resets |

## Quick start

Requires Node 22+ and Docker.

```bash
git clone git@github.com:stark-3k/bulletz.git
cd bulletz
npm install

npm run db:up          # Postgres 17 + pgvector on :5433
npm run db:migrate
npm run dev            # server on :4000, web on :5174
```

Open http://localhost:5174. The first run creates the workspace and makes you its owner.

For the desktop app, with the server already running:

```bash
npm run dev:desktop
```

### Connecting your agent

Settings → **API tokens** mints a credential, or onboarding generates one for your agent identity. Drop it into your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "bulletz": {
      "command": "npx",
      "args": ["-y", "@bulletz/mcp"],
      "env": {
        "BULLETZ_SERVER_URL": "https://bulletz.your-team.com",
        "BULLETZ_TOKEN": "blz_t_…"
      }
    }
  }
}
```

Then tell your agent to call `context_pack` before non-trivial work.

## Packaging the desktop app

```bash
npm run package -w @bulletz/desktop
```

Produces unsigned `.dmg` and `.zip` for arm64 and x64 in `packages/desktop/release/`. The build strips `VITE_BULLETZ_TOKEN` and refuses to package if any credential is found in the bundle.

Publishing a GitHub release tagged `v<version>` builds the same binaries in CI
and attaches them — macOS arm64 and x64 on their own runners, since cross-building
risks shipping the wrong architecture's `node-pty`. Windows is built best-effort
and cannot block a release. There is no Linux target: `node-pty` publishes no
Linux prebuilds, so an AppImage would ship without a working terminal.

> Builds are **ad-hoc signed only**. Gatekeeper will block them on other machines without an Apple Developer ID and notarization.

## Layout

```
packages/
  server/    Fastify + Postgres. Event log, auth, search, voice signalling.
  mcp/       The MCP bridge an agent talks to.
  web/       React + Vite. The workspace UI.
  desktop/   Electron shell: pty, agent runner, screen capture.
  shared/    Types shared across the above.
```

Design rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

**Stack** — TypeScript, Fastify 5, Postgres 17 + pgvector, `ws`, zod, React 18, Vite 6, Electron 33, node-pty.

## Self-hosting

The server binds `127.0.0.1` and expects a reverse proxy in front of it. Before exposing it:

- [ ] TLS and a real hostname (Caddy or nginx)
- [ ] Postgres off the public interface
- [ ] CORS allowlist instead of reflecting any origin
- [ ] Rate limits on `/v1/auth/*`
- [ ] A TURN server if voice is used — without it, peers behind symmetric NAT cannot connect
- [ ] Backups of the event log

Accounts are **invite-only** by design. `POST /v1/bootstrap` creates the first workspace and then permanently closes itself, so the server is never an open door. There is no self-registration; admins issue invites, and password resets are admin-minted codes handed over out of band. If the sole owner is locked out:

```bash
npm run reset-password -w @bulletz/server -- <handle>
```

## Status

Early, and honest about it. The stack runs end to end — but these are the known gaps:

- No file or image attachments; messages are text only
- Voice mesh is practical to roughly five participants
- No TURN deployed, so some networks cannot connect voice
- The rollups table exists but nothing compacts into it yet
- Desktop builds are unsigned

## License

Not yet licensed. All rights reserved for now.
