import { spawn as spawnPty, type IPty } from "node-pty";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readFileSync as readFileSyncRaw, writeFileSync, mkdirSync } from "node:fs";
import { ClaudeCodeAdapter, DEFAULT_POLICY, type AgentEvent, type Policy } from "./agent.js";

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

const terminals = new Map<string, IPty>();

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

/** Posts an agent's turn into the shared thread, so the work is visible to the
 *  whole team instead of dying in one person's scrollback. */
async function postToThread(
  threadId: string,
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
    console.warn("BULLETZ_AGENT_TOKEN is not set; agent output will not be posted to the thread");
    return;
  }
  try {
    await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ thread_id: threadId, kind, body, payload }),
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
    for (const [id, pty] of terminals) {
      pty.kill();
      terminals.delete(id);
    }
  });

  return win;
}

app.whenReady().then(() => {
  const win = createWindow();

  /* ------------------------------ terminal ------------------------------ */

  ipcMain.handle("term:spawn", (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    terminals.get(id)?.kill();

    const shellPath = process.env.SHELL ?? "/bin/zsh";
    const pty = spawnPty(shellPath, ["-l"], {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: PROJECT_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        ...projectEnv(),
        TERM: "xterm-256color",
        BULLETZ_PROJECT: PROJECT_ROOT,
      },
    });

    pty.onData((data) => {
      if (!win.isDestroyed()) win.webContents.send("term:data", { id, data });
    });
    pty.onExit(({ exitCode }) => {
      terminals.delete(id);
      if (!win.isDestroyed()) win.webContents.send("term:exit", { id, exitCode });
    });

    terminals.set(id, pty);
    return { cwd: PROJECT_ROOT, shell: shellPath };
  });

  ipcMain.on("term:write", (_e, { id, data }: { id: string; data: string }) => {
    terminals.get(id)?.write(data);
  });

  ipcMain.on("term:resize", (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    try {
      terminals.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 2));
    } catch {
      /* pty already gone */
    }
  });

  ipcMain.on("term:kill", (_e, { id }: { id: string }) => {
    terminals.get(id)?.kill();
    terminals.delete(id);
  });

  /* -------------------------- agent adapter --------------------------- */

  const adapter = new ClaudeCodeAdapter({
    cwd: PROJECT_ROOT,
    env: projectEnv(),
    mcpConfig: join(PROJECT_ROOT, ".mcp.json"),
    onEvent: (threadId, e: AgentEvent) => {
      if (!win.isDestroyed()) win.webContents.send("agent:event", { threadId, event: e });
      // Mirror the turn into the shared log. Text becomes a message from the
      // agent's own identity; tool calls become tool_call events.
      if (e.type === "text") void postToThread(threadId, "message", e.text);
      else if (e.type === "tool") void postToThread(threadId, "tool_call", e.name, { input: e.input });
      else if (e.type === "start")
        void postToThread(threadId, "agent_turn_start", null, { model: e.model, session: e.sessionId });
      else if (e.type === "end")
        void postToThread(threadId, "agent_turn_end", null, { subtype: e.subtype, cost_usd: e.costUsd, turns: e.turns });
      else if (e.type === "error") void postToThread(threadId, "agent_error", e.message);
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
    async (_e, { threadId, prompt, byOwner }: { threadId: string; prompt: string; byOwner: boolean }) => {
      const policy = loadPolicy();
      if (!policy.enabled) {
        return { ok: false, error: "Chat-triggered agent runs are disabled on this machine." };
      }
      if (policy.triggerFrom === "owner" && !byOwner) {
        return { ok: false, error: "Only this machine's owner may start a turn here." };
      }
      if (adapter.isRunning(threadId)) {
        return { ok: false, error: "A turn is already running in this thread." };
      }
      const trusted = byOwner || !policy.restrictOthers;
      void adapter.run(threadId, prompt, policy, trusted);
      return { ok: true };
    },
  );

  ipcMain.handle("agent:stop", (_e, { threadId }: { threadId: string }) => adapter.stop(threadId));
  ipcMain.handle("agent:status", (_e, { threadId }: { threadId: string }) => ({
    running: adapter.isRunning(threadId),
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
