import { spawn as spawnPty, type IPty } from "node-pty";
import { BrowserWindow, Notification, app, desktopCapturer, dialog, ipcMain, nativeImage, session, shell, systemPreferences } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { readFileSync as readFileSyncRaw, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { ClaudeCodeAdapter, DEFAULT_POLICY, type AgentEvent, type Policy } from "./agent.js";
import { SessionStore, type RunRecord } from "./sessions.js";

const exec = promisify(execFile);

// Before anything reads userData. The default is derived from the package
// name, which for a scoped workspace package is "@bulletz/desktop" — a nested
// directory, and "Electron" in the menu bar.
app.setName("Bulletz");

/**
 * The folder the terminal and the agent work in.
 *
 * Running from source this is the repo, so `claude` picks up its .mcp.json and
 * reaches Bulletz. A packaged app has no repo — resolving upward from __dirname
 * lands *inside the .app bundle*, which is read-only and not anybody's project
 * — so an installed copy has to be told which folder to work in, and remembers
 * it. Until it is told, home is the only safe guess.
 */
const projectFile = () => join(app.getPath("userData"), "project.json");

function storedProject(): string | null {
  try {
    const raw = JSON.parse(readFileSync(projectFile(), "utf8")) as { dir?: string };
    return typeof raw.dir === "string" && raw.dir && existsSync(raw.dir) ? raw.dir : null;
  } catch {
    return null;
  }
}

function storeProject(dir: string | null) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(projectFile(), JSON.stringify({ dir }, null, 2));
}

function projectRoot(): string {
  const chosen = storedProject();
  if (chosen) return chosen;
  if (process.env.BULLETZ_PROJECT) return process.env.BULLETZ_PROJECT;
  // Unpackaged, __dirname is packages/desktop/dist and the repo is three up.
  if (!app.isPackaged) return resolve(__dirname, "..", "..", "..");
  return app.getPath("home");
}

/**
 * Adopt the PATH a terminal would have.
 *
 * An app launched from Finder or the Dock inherits launchd's environment, not
 * a shell's — typically just /usr/bin:/bin:/usr/sbin:/sbin. Every tool a
 * developer installs lives somewhere else: nvm, Homebrew, pnpm, asdf, cargo.
 * So `claude` is right there in the user's shell and invisible to this
 * process, and a chat-triggered run fails with a bare `spawn claude ENOENT`
 * that points at nothing.
 *
 * Asking the login shell is the only reliable way to find out, because the
 * answer is whatever that person's dotfiles say it is. Interactive (-i) as
 * well as login (-l): plenty of people set PATH in .zshrc, which a
 * non-interactive shell never reads.
 */
function adoptShellPath() {
  // Launched from a terminal, the PATH is already the real one.
  if (!app.isPackaged && process.env["TERM"]) return;
  const shell = process.env["SHELL"];
  if (!shell || process.platform === "win32") return;
  try {
    const out = execFileSync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      // A dotfile that prints a banner would otherwise end up in the PATH.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out.includes("/")) return;
    const merged = [...new Set([...out.split(":"), ...(process.env["PATH"] ?? "").split(":")])]
      .filter(Boolean)
      .join(":");
    process.env["PATH"] = merged;
  } catch {
    // A shell that hangs or errors is not a reason to refuse to start; the
    // agent will simply report that it cannot find its binary.
  }
}

/** Icon assets live beside the compiled main, so they survive packaging.
 *  .icns is what macOS wants; the PNG is for Windows, Linux, and the dock
 *  override below. */
const ASSETS = join(__dirname, "..", "assets");
/** Our version, not the Electron shell's — app.getVersion() falls back to the
 *  bundle's CFBundleShortVersionString when running from source. */
const APP_VERSION = (() => {
  try {
    return (
      JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version?: string }
    ).version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
})();
const ICON_PNG = join(ASSETS, "icon.png");
/** Unused at runtime — nativeImage cannot read .icns. It exists for the
 *  packaging step, which embeds it in the macOS bundle's Info.plist. */
export const ICON_ICNS = join(ASSETS, "icon.icns");
const DEV_URL = process.env.BULLETZ_DEV_URL;

/** The built web UI. Packaged, electron-builder copies packages/web/dist into
 *  Contents/Resources/web; from source it is still in the repo. This
 *  deliberately does NOT go through projectRoot(): the renderer ships with the
 *  app and has nothing to do with whichever folder the user works in. */
const RENDERER_HTML = app.isPackaged
  ? join(process.resourcesPath, "web", "index.html")
  : join(resolve(__dirname, "..", "..", ".."), "packages", "web", "dist", "index.html");

/** Read packages/web/.env.local so a dev terminal inherits the same token the
 *  UI uses — that is what makes `claude` in this pane see the workspace. */
function projectEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  // Dev convenience only: a packaged app has no repo to read this from.
  const envFile = app.isPackaged
    ? ""
    : join(resolve(__dirname, "..", "..", ".."), "packages", "web", ".env.local");
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*(?:VITE_)?(BULLETZ_[A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m?.[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  // The window's choice wins over the checked-in dev defaults: the agent and
  // the MCP bridge must talk to the SAME server the UI is signed in to, or the
  // agent reads one workspace and posts into another.
  const chosen = storedServer();
  if (chosen) out["BULLETZ_SERVER_URL"] = chosen;
  // Likewise the agent credential. Without this an installed copy has no way
  // to get one at all — .env.local is a file in a repo it does not have — and
  // chat-triggered runs fail silently with nothing to post under.
  const agentToken = storedAgentToken();
  if (agentToken) out["BULLETZ_AGENT_TOKEN"] = agentToken;
  return out;
}

/**
 * The agent's own credential, kept beside the other machine-local state.
 *
 * It is deliberately NOT the human's token: the agent posts under its own
 * actor, and falling back to a person's token is the impersonation the whole
 * actor model exists to prevent. Onboarding mints it; this is where it lands.
 */
const agentTokenFile = () => join(app.getPath("userData"), "agent-token.json");

/**
 * Agent credentials, one per server.
 *
 * An agent token is an identity inside a single workspace and meaningless in
 * any other, so there is no such thing as "the" agent token once this app can
 * be signed in to several. Keyed by server URL, which is what identifies a
 * workspace here — one server, one workspace.
 */
type AgentTokens = { byServer?: Record<string, string>; token?: string };

function readAgentTokens(): AgentTokens {
  try {
    return JSON.parse(readFileSync(agentTokenFile(), "utf8")) as AgentTokens;
  } catch {
    return {};
  }
}

function storedAgentToken(serverUrl?: string | null): string | null {
  const raw = readAgentTokens();
  const key = serverUrl ?? storedServer();
  if (key && raw.byServer?.[key]) return raw.byServer[key]!;
  // The pre-multi-workspace file held a single token with no server attached.
  // It belongs to whichever workspace was signed in at the time, which is the
  // only one that existed — so it stays usable until a per-server one is set.
  return typeof raw.token === "string" && raw.token ? raw.token : null;
}

function storeAgentToken(token: string | null, serverUrl?: string | null) {
  const key = serverUrl ?? storedServer();
  const raw = readAgentTokens();
  const byServer = { ...(raw.byServer ?? {}) };
  if (key) {
    if (token) byServer[key] = token;
    else delete byServer[key];
  }
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(
    agentTokenFile(),
    // The legacy single token is dropped once a keyed one exists for the same
    // server, so it cannot later be mistaken for a different workspace's.
    JSON.stringify({ byServer }, null, 2),
    { mode: 0o600 },
  );
}

/** The server URL the renderer settled on, persisted outside the project tree
 *  so it survives a packaged build that has no .env.local to read. */
const serverFile = () => join(app.getPath("userData"), "server.json");

function storedServer(): string | null {
  try {
    const raw = JSON.parse(readFileSync(serverFile(), "utf8")) as { url?: string };
    return typeof raw.url === "string" && raw.url ? raw.url : null;
  } catch {
    return null;
  }
}

function storeServer(url: string | null) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(serverFile(), JSON.stringify({ url }, null, 2));
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
/** Where a run posts its results. Captured when the run starts, never read
 *  back from current state: someone switching workspaces mid-run must not
 *  redirect an answer into a team that never asked the question. */
type RunTarget = { base: string; token: string | undefined };

function currentTarget(): RunTarget {
  const env = projectEnv();
  return {
    base: env["BULLETZ_SERVER_URL"] ?? "http://localhost:4000",
    token: env["BULLETZ_AGENT_TOKEN"],
  };
}

async function postToChannel(
  target: RunTarget,
  channelId: string,
  kind: string,
  body: string | null,
  payload: Record<string, unknown> = {},
) {
  const base = target.base;
  // The agent posts under its OWN identity. Falling back to the human's token
  // would make the agent's work read as if a person wrote it, which is exactly
  // what the actor model exists to prevent — so there is no fallback.
  const token = target.token;
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

/** macOS reads the icon from the bundle's Info.plist, which only exists once
 *  the app is packaged. Running from source there is no bundle, so the dock
 *  shows Electron's own atom unless it is set explicitly at runtime. */
/** Every userData directory this app has used before the current one.
 *  Each rename of the app moves the directory, and anything already written
 *  there — the agent policy, the private session log — would otherwise look
 *  like a factory reset. */
const LEGACY_USER_DATA = [
  join("@bulletz", "desktop"), // derived from the scoped package name
  "bulletz", // before the product name was capitalised
];
const CARRIED_FILES = [
  "agent-policy.json",
  "agent-sessions.jsonl",
  "server.json",
  "project.json",
  "agent-token.json",
];

function migrateUserData() {
  const now = app.getPath("userData");
  for (const legacy of LEGACY_USER_DATA) {
    const old = join(dirname(now), legacy);
    if (old === now || !existsSync(old)) continue;
    mkdirSync(now, { recursive: true });
    for (const name of CARRIED_FILES) {
      const from = join(old, name);
      const to = join(now, name);
      // On a case-insensitive volume "bulletz" and "Bulletz" are the same
      // directory, so `to` already exists and this correctly does nothing
      // rather than copying a file over itself.
      if (!existsSync(from) || existsSync(to)) continue;
      try {
        copyFileSync(from, to);
        console.log(`migrated ${name} from ${legacy}`);
      } catch {
        /* a failed copy is not a reason to refuse to start */
      }
    }
  }
}

function applyAppIdentity() {
  if (process.platform !== "darwin" || !app.dock) return;

  // The About panel takes its text from the bundle unless told otherwise, and
  // running from source that bundle is Electron's — so without this it reports
  // Electron's version number as the app's.
  app.setAboutPanelOptions({
    applicationName: "Bulletz",
    applicationVersion: APP_VERSION,
    version: "",
    copyright: `© ${new Date().getFullYear()} Bulletz`,
  });
  try {
    const icon = nativeImage.createFromPath(ICON_PNG);
    if (icon.isEmpty()) {
      console.warn(`dock icon did not load from ${ICON_PNG}`);
      return;
    }
    app.dock.setIcon(icon);
  } catch {
    /* a missing icon is not worth refusing to start over */
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
    icon: ICON_PNG,
    // The lights are 12px tall in a 38px title bar, so (38-12)/2 = 13 centres
    // them on the same line as the mark and the nav.
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Handed over at launch, synchronously, because the renderer has to know
      // which server it belongs to BEFORE its first request — and a packaged
      // app loads over file://, where there is no origin to infer it from.
      additionalArguments: [`--bulletz-server=${storedServer() ?? ""}`],
    },
  });

  // Links to external sites open in the real browser, never in the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(RENDERER_HTML);

  // macOS hides the traffic lights in fullscreen, so the space the title bar
  // reserves for them becomes dead space. Tell the renderer which it is.
  const sendFullscreen = () => {
    if (!win.isDestroyed()) win.webContents.send("window:fullscreen", win.isFullScreen());
  };
  win.on("enter-full-screen", sendFullscreen);
  win.on("leave-full-screen", sendFullscreen);
  win.webContents.on("did-finish-load", sendFullscreen);

  win.on("closed", () => {
    for (const [id, t] of terminals) {
      t.pty.kill();
      terminals.delete(id);
    }
  });

  return win;
}

app.whenReady().then(() => {
  adoptShellPath();
  migrateUserData();
  applyAppIdentity();

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
        cwd: projectRoot(),
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
      cwd: projectRoot(),
      env: {
        ...(process.env as Record<string, string>),
        // `claude` started in this pane is an agent too, so it posts as one.
        ...agentEnv(),
        TERM: "xterm-256color",
        BULLETZ_PROJECT: projectRoot(),
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
    return { cwd: projectRoot(), shell: shellPath, replay: "", reattached: false };
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

  /** Where each in-flight run posts. Captured at start so that switching
   *  workspaces mid-run cannot redirect an answer into a team that never
   *  asked the question. */
  const runTargets = new Map<string, RunTarget>();

  const adapter = new ClaudeCodeAdapter({
    // Resolved per run: both the project folder and the active workspace can
    // change while the app is open.
    cwd: () => projectRoot(),
    env: () => agentEnv(),
    mcpConfig: join(projectRoot(), ".mcp.json"),
    // Carry each channel's claude session across app restarts, so a channel
    // keeps one continuous conversation instead of meeting a stranger.
    resumeSessions: sessions.latestSessions(),
    onEvent: (channelId, e: AgentEvent) => {
      // Accumulate the run so it survives the window. The transcript stays
      // local — this file is never sent to the server.
      const target = runTargets.get(channelId) ?? currentTarget();

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
          runTargets.delete(channelId);
        } else if (e.type === "error") {
          rec.endedAt = new Date().toISOString();
          rec.status = "error";
          sessions.append(rec);
          inFlight.delete(channelId);
          runTargets.delete(channelId);
        }
      }

      // The transcript is PRIVATE: it goes to this window only. An agent
      // thinking out loud and calling twelve tools is working, not reporting,
      // and mirroring all of it into a shared channel buries the room in noise.
      // The agent decides what teammates see by calling post_message itself.
      if (!win.isDestroyed()) win.webContents.send("agent:event", { channelId, event: e });

      // Opt-in escape hatch for anyone who wants the old firehose.
      if (loadPolicy().postTranscript) {
        if (e.type === "text") void postToChannel(target, channelId, "message", e.text);
        else if (e.type === "tool") void postToChannel(target, channelId, "tool_call", e.name, { input: e.input });
        else if (e.type === "end")
          void postToChannel(target, channelId, "agent_turn_end", null, {
            subtype: e.subtype,
            cost_usd: e.costUsd,
            turns: e.turns,
          });
      }
      // An error is the one thing worth surfacing regardless: a run that died
      // silently looks to the room like nobody ever picked the task up.
      if (e.type === "error") void postToChannel(target, channelId, "agent_error", e.message);
    },
  });

  // The renderer owns the choice (it is the thing that can actually probe the
  // address); main owns persisting it, because the agent and the MCP bridge
  // run here and need the same answer.
  // Onboarding mints the agent credential in the renderer; it has to reach
  // main, which is where the agent and the MCP bridge actually run.
  ipcMain.handle("agent:token", (_e, token: unknown) => {
    if (token === undefined) return storedAgentToken() !== null;
    storeAgentToken(typeof token === "string" && token ? token : null);
    return storedAgentToken() !== null;
  });

  /** An OS notification, and the dock badge that goes with it. The renderer
   *  decides what is worth surfacing; main only knows how to show it. */
  ipcMain.handle(
    "notify:show",
    (_e, n: { title?: unknown; body?: unknown; channelId?: unknown } | undefined) => {
      if (!Notification.isSupported() || !n || typeof n.title !== "string") return false;
      const note = new Notification({
        title: n.title,
        body: typeof n.body === "string" ? n.body : "",
        silent: false,
      });
      // Clicking it should take you to the thing, not just raise the window.
      note.on("click", () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (typeof n.channelId === "string") win.webContents.send("notify:open", n.channelId);
      });
      note.show();
      return true;
    },
  );

  ipcMain.handle("notify:badge", (_e, count: unknown) => {
    const n = typeof count === "number" && count > 0 ? count : 0;
    if (process.platform === "darwin" && app.dock) {
      app.dock.setBadge(n > 0 ? (n > 99 ? "99+" : String(n)) : "");
    } else {
      app.setBadgeCount(n);
    }
    return true;
  });

  ipcMain.handle("app:version", () => APP_VERSION);

  ipcMain.handle("project:get", () => ({
    dir: projectRoot(),
    chosen: storedProject() !== null,
    packaged: app.isPackaged,
  }));
  ipcMain.handle("project:choose", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: "Choose the folder Bulletz should work in",
          properties: ["openDirectory", "createDirectory"],
          defaultPath: projectRoot(),
        })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return { dir: projectRoot(), changed: false };
    storeProject(res.filePaths[0]);
    // Existing shells keep their old cwd; a pty cannot be moved. New ones pick
    // the change up, and the UI says so.
    return { dir: res.filePaths[0], changed: true };
  });

  ipcMain.handle("server:get", () => storedServer());
  ipcMain.handle("server:set", (_e, url: unknown) => {
    storeServer(typeof url === "string" && url ? url : null);
    return storedServer();
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
      // Pin this run to the workspace it was started from.
      runTargets.set(channelId, currentTarget());
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
        const { stdout } = await exec("git", args, { cwd: projectRoot() });
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
      cwd: projectRoot().replace(homedir(), "~"),
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
