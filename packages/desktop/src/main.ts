import { spawn as spawnPty, type IPty } from "node-pty";
import { BrowserWindow, app, desktopCapturer, ipcMain, session, shell, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readFileSync as readFileSyncRaw, writeFileSync, mkdirSync } from "node:fs";
import { ClaudeCodeAdapter, DEFAULT_POLICY, type AgentEvent, type Policy } from "./agent.js";
import { SessionStore, type RunRecord } from "./sessions.js";

const exec = promisify(execFile);

/** The workspace root the terminal opens in. Defaults to the repo this app
 *  lives in, so `claude` picks up its .mcp.json and reaches bulletz. */
const PROJECT_ROOT = process.env.BULLETZ_PROJECT ?? resolve(__dirname, "..", "..", "..");
const DEV_URL = process.env.BULLETZ_DEV_URL;

/** Read packages/web/.env.local so a dev terminal inherits the same token the
 *  UI uses — that is what makes `claude` in this pane see the workspace. */
function projectEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envFile = join(PROJECT_ROOT, "packages", "web", ".env.local");
  if (!existsSync(envFile)) return out;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*(?:VITE_)?(BULLETZ_[A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}


/** Environment for anything that runs an AGENT. The MCP server authenticates
 *  with BULLETZ_TOKEN, so leaving the human's token there makes the agent's own
 *  post_message land in the channel under a person's name — the exact
 *  impersonation the actor model exists to prevent. */
function agentEnv(): Record<string, string> {
  const env = projectEnv();
  const agentToken = env["BULLETZ_AGENT_TOKEN"];
  return agentToken ? { ...env, BULLETZ_TOKEN: agentToken } : env;
}

/** A pty plus a bounded replay buffer.
 *
 *  The renderer can go away at any moment — a reload, a hot update — and the
 *  shell must not go with it. The pty lives here, and its recent output is kept
 *  so a reattaching view can be handed the scrollback it missed instead of a
 *  blank screen and a dead job. */
type Terminal = { pty: IPty; buffer: string[]; bytes: number };
const terminals = new Map<string, Terminal>();

/** The source the user picked, consumed by the next getDisplayMedia call. */
let pendingShareSource: string | null = null;

const MAX_BUFFER_BYTES = 256 * 1024;

function record(t: Terminal, data: string) {
  t.buffer.push(data);
  t.bytes += data.length;
  while (t.bytes > MAX_BUFFER_BYTES && t.buffer.length > 1) {
    t.bytes -= t.buffer.shift()!.length;
  }
}

/* ----------------------------- agent policy ----------------------------- */
// Lives on disk, owned by this machine. A teammate's chat message starting a
// shell here is remote code execution, so the laptop keeps its own veto rather
// than trusting a server-side permission.
const policyPath = join(app.getPath("userData"), "agent-policy.json");

function loadPolicy(): Policy {
  try {
    return { ...DEFAULT_POLICY, ...(JSON.parse(readFileSyncRaw(policyPath, "utf8")) as Partial<Policy>) };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function savePolicy(p: Policy) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(policyPath, JSON.stringify(p, null, 2));
}

/** Posts an agent's turn into the shared channel, so the work is visible to the
 *  whole team instead of dying in one person's scrollback. */
async function postToChannel(
  channelId: string,
  kind: string,
  body: string | null,
  payload: Record<string, unknown> = {},
) {
  const env = projectEnv();
  const base = env["BULLETZ_SERVER_URL"] ?? "http://localhost:4000";
  // The agent posts under its OWN identity. Falling back to the human's token
  // would make the agent's work read as if a person wrote it, which is exactly
  // what the actor model exists to prevent — so there is no fallback.
  const token = env["BULLETZ_AGENT_TOKEN"];
  if (!token) {
    console.warn("BULLETZ_AGENT_TOKEN is not set; agent output will not be posted to the channel");
    return;
  }
  try {
    await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel_id: channelId, kind, body, payload }),
    });
  } catch {
    /* the UI still sees the live stream over IPC */
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#0d1017",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 11 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
sandbox: false,
    },
  });

  // Links to external sites open in the real browser, never in the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(PROJECT_ROOT, "packages", "web", "dist", "index.html"));

  win.on("closed", () => {
    for (const [id, t] of terminals) {
      t.pty.kill();
      terminals.delete(id);
    }
  });

  return win;
}

app.whenReady().then(() => {
  // Screen sharing: getDisplayMedia() has no picker in Electron, so the app
  // supplies the source. We hand the renderer the list and let the person
  // choose, rather than silently granting the whole screen.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer.getSources({ types: ["screen", "window"] }).then((sources) => {
        const chosen = pendingShareSource
          ? sources.find((s) => s.id === pendingShareSource)
          : sources[0];
        pendingShareSource = null;
        // audio:'loopback' would capture system sound; left off so a share
        // never picks up the call itself and echoes.
        callback(chosen ? { video: chosen } : {});
      });
    },
    { useSystemPicker: false },
  );

  const win = createWindow();

  const sessions = new SessionStore(join(app.getPath("userData"), "agent-sessions.jsonl"));
  /** Runs still in flight, accumulating their transcript until they finish. */
  const inFlight = new Map<string, RunRecord>();

  /* ------------------------------ terminal ------------------------------ */

  ipcMain.handle("term:spawn", (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    // Reattach rather than respawn. Killing the old pty here is what made every
    // reload a fresh shell with the previous job dead.
    const existing = terminals.get(id);
    if (existing) {
      try {
        existing.pty.resize(Math.max(cols || 80, 2), Math.max(rows || 24, 2));
      } catch {
        /* pty gone between checks */
      }
      return {
        cwd: PROJECT_ROOT,
        shell: process.env.SHELL ?? "/bin/zsh",
        replay: existing.buffer.join(""),
        reattached: true,
      };
    }

    const shellPath = process.env.SHELL ?? "/bin/zsh";
    const pty = spawnPty(shellPath, ["-l"], {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: PROJECT_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        // `claude` started in this pane is an agent too, so it posts as one.
        ...agentEnv(),
        TERM: "xterm-256color",
        BULLETZ_PROJECT: PROJECT_ROOT,
      },
    });

    const term: Terminal = { pty, buffer: [], bytes: 0 };

    pty.onData((data) => {
      record(term, data);
      if (!win.isDestroyed()) win.webContents.send("term:data", { id, data });
    });
    pty.onExit(({ exitCode }) => {
      terminals.delete(id);
      if (!win.isDestroyed()) win.webContents.send("term:exit", { id, exitCode });
    });

    terminals.set(id, term);
    return { cwd: PROJECT_ROOT, shell: shellPath, replay: "", reattached: false };
  });

  ipcMain.on("term:write", (_e, { id, data }: { id: string; data: string }) => {
    terminals.get(id)?.pty.write(data);
  });

  ipcMain.on("term:resize", (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    try {
      terminals.get(id)?.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
    } catch {
      /* pty already gone */
    }
  });

  // Only an explicit kill ends a shell. A view going away is not one.
  ipcMain.on("term:kill", (_e, { id }: { id: string }) => {
    terminals.get(id)?.pty.kill();
    terminals.delete(id);
  });

  /* -------------------------- agent adapter --------------------------- */

  const adapter = new ClaudeCodeAdapter({
    cwd: PROJECT_ROOT,
    env: agentEnv(),
    mcpConfig: join(PROJECT_ROOT, ".mcp.json"),
    // Carry each channel's claude session across app restarts, so a channel
    // keeps one continuous conversation instead of meeting a stranger.
    resumeSessions: sessions.latestSessions(),
    onEvent: (channelId, e: AgentEvent) => {
      // Accumulate the run so it survives the window. The transcript stays
      // local — this file is never sent to the server.
      const rec = inFlight.get(channelId);
      if (rec) {
        rec.events.push(e);
        if (e.type === "start") {
          rec.sessionId = e.sessionId;
          rec.model = e.model;
        } else if (e.type === "end") {
          rec.endedAt = new Date().toISOString();
          rec.status = e.subtype;
          rec.costUsd = e.costUsd;
          rec.turns = e.turns;
          sessions.append(rec);
          inFlight.delete(channelId);
        } else if (e.type === "error") {
          rec.endedAt = new Date().toISOString();
          rec.status = "error";
          sessions.append(rec);
          inFlight.delete(channelId);
        }
      }

      // The transcript is PRIVATE: it goes to this window only. An agent
      // thinking out loud and calling twelve tools is working, not reporting,
      // and mirroring all of it into a shared channel buries the room in noise.
      // The agent decides what teammates see by calling post_message itself.
      if (!win.isDestroyed()) win.webContents.send("agent:event", { channelId, event: e });

      // Opt-in escape hatch for anyone who wants the old firehose.
      if (loadPolicy().postTranscript) {
        if (e.type === "text") void postToChannel(channelId, "message", e.text);
        else if (e.type === "tool") void postToChannel(channelId, "tool_call", e.name, { input: e.input });
        else if (e.type === "end")
          void postToChannel(channelId, "agent_turn_end", null, {
            subtype: e.subtype,
            cost_usd: e.costUsd,
            turns: e.turns,
          });
      }
      // An error is the one thing worth surfacing regardless: a run that died
      // silently looks to the room like nobody ever picked the task up.
      if (e.type === "error") void postToChannel(channelId, "agent_error", e.message);
    },
  });

  ipcMain.handle("agent:policy", (_e, patch?: Partial<Policy>) => {
    const current = loadPolicy();
    if (!patch) return current;
    const next = { ...current, ...patch };
    savePolicy(next);
    return next;
  });

  ipcMain.handle(
    "agent:run",
    async (
      _e,
      {
        channelId,
        prompt,
        byOwner,
        actorId,
        actorHandle,
      }: {
        channelId: string;
        prompt: string;
        byOwner: boolean;
        actorId?: string;
        actorHandle?: string;
      },
    ) => {
      const policy = loadPolicy();
      if (!policy.enabled) {
        return { ok: false, error: "Chat-triggered agent runs are disabled on this machine." };
      }
      if (policy.triggerFrom === "owner" && !byOwner) {
        return { ok: false, error: "Only this machine's owner may start a turn here." };
      }
      if (adapter.isRunning(channelId)) {
        return { ok: false, error: "A turn is already running in this channel." };
      }
      const trusted = byOwner || !policy.restrictOthers;
      inFlight.set(channelId, {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        actorId: actorId ?? null,
        actorHandle: actorHandle ?? null,
        channelId,
        sessionId: null,
        prompt,
        model: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "running",
        costUsd: null,
        turns: null,
        events: [],
      });
      void adapter.run(channelId, prompt, policy, trusted);
      return { ok: true };
    },
  );

  // Scoped by the caller's actor: signing in as someone else must not expose
  // the previous person's transcripts.
  ipcMain.handle("screen:sources", async () => {
    // macOS gates screen capture behind a per-app permission that cannot be
    // requested from code — the user has to grant it in System Settings and
    // relaunch. Without this check desktopCapturer just throws "Failed to get
    // sources", which tells nobody anything.
    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status !== "granted") {
        return { error: "permission", status };
      }
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
      });
      return {
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
          isScreen: s.id.startsWith("screen:"),
        })),
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });

  /** Opens the exact pane the permission lives in. */
  ipcMain.handle("screen:openSettings", () => {
    void shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    return true;
  });

  ipcMain.handle("screen:pick", (_e, { id }: { id: string }) => {
    pendingShareSource = id;
    return true;
  });

  ipcMain.handle("agent:sessions", (_e, { actorId }: { actorId?: string } = {}) =>
    sessions.list(actorId ?? null),
  );
  ipcMain.handle("agent:session", (_e, { id, actorId }: { id: string; actorId?: string }) =>
    sessions.get(id, actorId ?? null),
  );
  ipcMain.handle("agent:stop", (_e, { channelId }: { channelId: string }) => adapter.stop(channelId));
  ipcMain.handle("agent:status", (_e, { channelId }: { channelId: string }) => ({
    running: adapter.isRunning(channelId),
  }));

  win.on("closed", () => adapter.stopAll());

  /* ---------------------- local state, allowlisted ---------------------- */
  // Only these fields ever leave the machine. Never file contents.
  ipcMain.handle("local:status", async () => {
    const git = async (args: string[]) => {
      try {
        const { stdout } = await exec("git", args, { cwd: PROJECT_ROOT });
        return stdout.trim();
      } catch {
        return "";
      }
    };
    const [branch, status] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["status", "--porcelain"]),
    ]);
    return {
      branch: branch || null,
      dirty_files: status ? status.split("\n").filter(Boolean).length : 0,
      cwd: PROJECT_ROOT.replace(homedir(), "~"),
      machine: process.env.HOSTNAME ?? process.env.USER ?? "local",
    };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
