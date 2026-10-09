import { spawn as spawnPty, type IPty } from "node-pty";
import { BrowserWindow, Notification, app, desktopCapturer, dialog, ipcMain, nativeImage, session, shell, systemPreferences } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { readFileSync as readFileSyncRaw, writeFileSync, mkdirSync, copyFileSync } from "node:fs";

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

/**
 * One folder per workspace, keyed by server URL — the same shape the agent
 * credential uses, for the same reason.
 *
 * The folder and the workspace are not the same axis: you open a terminal
 * somewhere because that is the code you are touching, while the workspace
 * decides whose memory the agent can read. But a single global folder made
 * switching workspace a no-op for the agent, which sat in the previous team's
 * checkout and answered from it. Remembering the choice per workspace is what
 * lets a switch mean something without pretending the two are one thing.
 */
type Projects = { byServer?: Record<string, string>; dir?: string };

function readProjects(): Projects {
  try {
    return JSON.parse(readFileSync(projectFile(), "utf8")) as Projects;
  } catch {
    return {};
  }
}

function storedProject(serverUrl?: string | null): string | null {
  const raw = readProjects();
  const usable = (d?: string) => (typeof d === "string" && d && existsSync(d) ? d : null);
  const key = serverUrl ?? storedServer();
  if (key && raw.byServer?.[key]) return usable(raw.byServer[key]);
  // The pre-multi-workspace file held one folder with no server attached. It
  // stands in until this workspace has a folder of its own, which is what the
  // single-workspace install should see: no change at all.
  return usable(raw.dir);
}

function storeProject(dir: string | null, serverUrl?: string | null) {
  const key = serverUrl ?? storedServer();
  const raw = readProjects();
  const byServer = { ...(raw.byServer ?? {}) };
  if (key) {
    if (dir) byServer[key] = dir;
    else delete byServer[key];
  }
  mkdirSync(app.getPath("userData"), { recursive: true });
  // The unkeyed folder is dropped once a keyed one exists, so it cannot later
  // be mistaken for a workspace that never chose anything.
  writeFileSync(projectFile(), JSON.stringify(key ? { byServer } : { dir }, null, 2));
}

/**
 * The pointer a project directory may carry: which workspace this code
 * belongs to.
 *
 * It is written to be committed. That is the whole value — a teammate clones
 * the repository, opens the folder, and their agent reaches the same team's
 * memory without anyone walking them through it. Which also means it is
 * untrusted input: anyone can put a server in a repository, so this file is
 * only ever a claim. It names a host; it never carries a credential, and
 * finding one must never connect, switch workspace, or send a token
 * anywhere. A person confirms, and the binding that results is stored here
 * in userData like any other.
 */
const PROJECT_CONFIG = "bulletz.json";

export type ProjectConfig = { server: string; workspace?: string };

function readProjectConfig(dir: string): ProjectConfig | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, PROJECT_CONFIG), "utf8")) as ProjectConfig;
    // http/https only. A file: or javascript: "server" is not a server, and
    // the rest of the app would carry it a long way before noticing.
    if (typeof raw?.server !== "string" || !/^https?:\/\//.test(raw.server)) return null;
    return {
      server: raw.server.replace(/\/+$/, ""),
      ...(typeof raw.workspace === "string" ? { workspace: raw.workspace.slice(0, 120) } : {}),
    };
  } catch {
    return null;
  }
}

function writeProjectConfig(dir: string, cfg: ProjectConfig) {
  // Deliberately only these two keys. There is no shape of this file that
  // should ever hold a token, so there is no code path here that could.
  const body = { server: cfg.server.replace(/\/+$/, ""), ...(cfg.workspace ? { workspace: cfg.workspace } : {}) };
  writeFileSync(join(dir, PROJECT_CONFIG), JSON.stringify(body, null, 2) + "\n");
}

/** Whether committing a pointer here would reach anyone. Offered by default
 *  in a repository and not outside one, because that is where it pays off. */
const looksLikeRepo = (dir: string) => existsSync(join(dir, ".git"));

function projectRoot(): string {
  const chosen = storedProject();
  if (chosen) return chosen;
  if (process.env.BULLETZ_PROJECT) return process.env.BULLETZ_PROJECT;
  // Unpackaged, __dirname is packages/desktop/dist and the repo is three up.
  if (!app.isPackaged) return resolve(__dirname, "..", "..", "..");
  return app.getPath("home");
}

/**
 * Did anyone actually choose this folder, or is it only the fallback?
 *
 * The difference matters for anything that runs a process. An installed app
 * with no choice recorded falls back to the home directory, and starting a
 * coding agent there hands it the whole of someone's home as its working set
 * — every document, every other project, every set of keys lying around.
 * macOS notices before the person does and opens the permission prompts for
 * Desktop, Documents and Downloads one after another, which is how this was
 * found. A guess is fine for showing a path; it is not fine for a cwd.
 */
function projectPicked(): boolean {
  return storedProject() !== null || Boolean(process.env.BULLETZ_PROJECT) || !app.isPackaged;
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
/** The MCP bridge, bundled to one file so an installed app carries it. */
const MCP_BUNDLE = join(ASSETS, "mcp.mjs");
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
  // VITE_BULLETZ_TOKEN is the HUMAN's credential — it is how the UI signs
  // in — and stripping the VITE_ prefix turns it into exactly the variable
  // the MCP bridge authenticates with. Left in place, an agent with no
  // credential of its own quietly becomes the person who started it, which
  // is the impersonation the whole actor model exists to prevent. The
  // agent's identity is set below, from its own token, or not at all.
  delete out["BULLETZ_TOKEN"];
  // The window's choice wins over the checked-in dev defaults: the agent and
  // the MCP bridge must talk to the SAME server the UI is signed in to, or the
  // agent reads one workspace and posts into another.
  const devServer = out["BULLETZ_SERVER_URL"] ?? out["BULLETZ_URL"];
  const devToken = out["BULLETZ_AGENT_TOKEN"];
  const server = storedServer() ?? devServer ?? "";
  if (server) out["BULLETZ_SERVER_URL"] = server;

  // A credential belongs to one workspace and is meaningless in any other, so
  // it is only ever paired with the server it was minted against. Previously
  // the URL was overridden to the signed-in server while the token was left
  // as whatever .env.local held — a localhost credential sent to a remote
  // host, which answers 401 and leaves the agent with no workspace and no
  // explanation of why.
  const sameHost = (a?: string, b?: string) =>
    Boolean(a && b) && a!.replace(/\/+$/, "") === b!.replace(/\/+$/, "");
  const token = storedAgentToken(server) ?? (sameHost(devServer, server) ? devToken : undefined);
  if (token) out["BULLETZ_AGENT_TOKEN"] = token;
  else delete out["BULLETZ_AGENT_TOKEN"];

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
  // It belongs to whichever workspace was signed in at the time — and with no
  // way to tell which, it may only stand in while there is still just one.
  if (storedServer()) return null;
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
  // No agent credential means no credential — never a borrowed one.
  if (!agentToken) {
    const { BULLETZ_TOKEN: _unused, ...rest } = env;
    return rest;
  }
  return { ...env, BULLETZ_TOKEN: agentToken };
}

/**
 * Which coding agent to run.
 *
 * Deliberately a command rather than an integration. The platform's whole
 * claim is that it does not care which agent you use — holding the team's
 * memory over MCP and letting whatever you already run read it — and the
 * previous implementation contradicted that by spawning `claude` with
 * Claude-Code-only flags baked in.
 *
 * A pty running your command gives that agent's own interface, interactive
 * and interruptible, and works for agents that do not exist yet.
 */
export type AgentCommand = { command: string; args: string[] };

/** Offered in settings, and used to guess on first run. Order is not a
 *  ranking — it is the order PATH is searched when nothing is configured. */
export const AGENT_PRESETS: { id: string; label: string; cmd: AgentCommand }[] = [
  { id: "claude", label: "Claude Code", cmd: { command: "claude", args: [] } },
  { id: "codex", label: "Codex CLI", cmd: { command: "codex", args: [] } },
  { id: "gemini", label: "Gemini CLI", cmd: { command: "gemini", args: [] } },
  { id: "opencode", label: "OpenCode", cmd: { command: "opencode", args: [] } },
  { id: "aider", label: "Aider", cmd: { command: "aider", args: [] } },
  { id: "cursor", label: "Cursor Agent", cmd: { command: "cursor-agent", args: [] } },
];

const agentCmdFile = () => join(app.getPath("userData"), "agent-command.json");

function onPath(cmd: string): boolean {
  try {
    execFileSync("command", ["-v", cmd], { stdio: "ignore", shell: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function storedAgentCommand(): AgentCommand | null {
  try {
    const raw = JSON.parse(readFileSync(agentCmdFile(), "utf8")) as Partial<AgentCommand>;
    if (typeof raw.command !== "string" || !raw.command.trim()) return null;
    return { command: raw.command.trim(), args: Array.isArray(raw.args) ? raw.args.map(String) : [] };
  } catch {
    return null;
  }
}

function storeAgentCommand(cmd: AgentCommand | null) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(agentCmdFile(), JSON.stringify(cmd ?? {}, null, 2));
}

/** The configured command, or the first preset actually installed. Returns
 *  null when nothing is configured and nothing is found, so the pane can say
 *  so instead of failing with a bare ENOENT. */
function resolveAgentCommand(): AgentCommand | null {
  const stored = storedAgentCommand();
  if (stored) return stored;
  for (const p of AGENT_PRESETS) if (onPath(p.cmd.command)) return p.cmd;
  return null;
}

/** A pty plus a bounded replay buffer.
 *
 *  The renderer can go away at any moment — a reload, a hot update — and the
 *  shell must not go with it. The pty lives here, and its recent output is kept
 *  so a reattaching view can be handed the scrollback it missed instead of a
 *  blank screen and a dead job. */
type Terminal = {
  /** Shell or agent. A pty id can outlive a change of mind about what it
   *  runs, and reattaching to the wrong kind silently gives you a shell
   *  where you asked for an agent. */
  kind: "shell" | "agent";
  pty: IPty;
  buffer: string[];
  bytes: number;
  /** The workspace this process was started against. A pty's environment is
   *  fixed at spawn, so switching workspace or minting a credential never
   *  reaches a session that is already running — it just starts answering
   *  401 with no explanation. Recorded so a reattach can say so. */
  startedWith: string;
};
const terminals = new Map<string, Terminal>();

/** Identifies the workspace a pty was started against: which server, whether
 *  it had a credential for it, and the folder it was started in. The folder
 *  belongs here because it is now per workspace — switching teams moves the
 *  cwd, and a pty cannot be moved after it is spawned. */
function envFingerprint(): string {
  const e = agentEnv();
  return [
    e["BULLETZ_SERVER_URL"] ?? "",
    e["BULLETZ_TOKEN"] ? "auth" : "anon",
    projectRoot(),
  ].join("|");
}

/** Tell every window that the workspace, credential or folder moved, so panes
 *  holding a pty from before can re-ask whether they are still current. */
function announceEnvChange() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("term:env-changed");
  }
}

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

/** Posts an agent's turn into the shared channel, so the work is visible to the
 *  whole team instead of dying in one person's scrollback. */
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
  "server.json",
  "project.json",
  "agent-command.json",
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

  /** Runs still in flight, accumulating their transcript until they finish. */

  /* ------------------------------ terminal ------------------------------ */

  ipcMain.handle(
    "term:spawn",
    (
      _e,
      { id, cols, rows, kind }: { id: string; cols: number; rows: number; kind?: "shell" | "agent" },
    ) => {
    // Nothing is started in a folder nobody chose. The pane says so and offers
    // the picker, which is a far better first run than silently taking $HOME.
    if (!projectPicked()) {
      return {
        cwd: "",
        shell: "",
        replay: "",
        reattached: false,
        needsProject: true,
        error:
          "Choose the folder Bulletz should work in. Until then there is no " +
          "safe place to start — your home directory would put every file you " +
          "own in the agent's reach.",
      };
    }

    // Reattach rather than respawn. Killing the old pty here is what made every
    // reload a fresh shell with the previous job dead.
    const want = kind ?? "shell";
    const existing = terminals.get(id);
    // Reattach only to a pty running the same thing. A stale one from before
    // this pane changed its mind would otherwise be handed back, and you get
    // a shell prompt where you asked for an agent.
    if (existing && existing.kind !== want) {
      try {
        existing.pty.kill();
      } catch {
        /* already gone */
      }
      terminals.delete(id);
    }
    const reuse = terminals.get(id);
    if (reuse) {
      try {
        reuse.pty.resize(Math.max(cols || 80, 2), Math.max(rows || 24, 2));
      } catch {
        /* pty gone between checks */
      }
      return {
        cwd: projectRoot(),
        shell: process.env.SHELL ?? "/bin/zsh",
        replay: reuse.buffer.join(""),
        reattached: true,
        // Tell the view when this process predates the current workspace
        // settings, so it can offer a restart rather than leaving someone to
        // wonder why their agent is unauthorised.
        stale: reuse.startedWith !== envFingerprint(),
      };
    }

    // An agent pane runs the configured coding agent instead of a login
    // shell. Same pty, same replay buffer, same reattach — the only
    // difference is what is on the other end of it.
    const agent = kind === "agent" ? resolveAgentCommand() : null;
    if (kind === "agent" && !agent) {
      return {
        cwd: projectRoot(),
        shell: "",
        replay: "",
        reattached: false,
        error:
          "No coding agent found. Set one in Settings — any CLI agent works; " +
          `we looked for ${AGENT_PRESETS.map((p) => p.cmd.command).join(", ")}.`,
      };
    }

    const shellPath = process.env.SHELL ?? "/bin/zsh";
    const file = agent ? agent.command : shellPath;
    const argv = agent ? agent.args : ["-l"];
    const pty = spawnPty(file, argv, {
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

    const term: Terminal = { pty, buffer: [], bytes: 0, kind: want, startedWith: envFingerprint() };

    pty.onData((data) => {
      record(term, data);
      if (!win.isDestroyed()) win.webContents.send("term:data", { id, data });
    });
    pty.onExit(({ exitCode }) => {
      terminals.delete(id);
      if (!win.isDestroyed()) win.webContents.send("term:exit", { id, exitCode });
    });

    terminals.set(id, term);
      return {
        cwd: projectRoot(),
        shell: agent ? `${agent.command} ${agent.args.join(" ")}`.trim() : shellPath,
        replay: "",
        reattached: false,
      };
    },
  );

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
  // Answered, not fire-and-forget. Restart is kill-then-remount, and a send
  // races the spawn that follows it: the new pane would reattach to the pty
  // it just asked to die, come back marked stale, and look like the button
  // did nothing. The caller can wait for this one.
  ipcMain.handle("term:kill", (_e, { id }: { id: string }) => {
    terminals.get(id)?.pty.kill();
    terminals.delete(id);
    return true;
  });

  ipcMain.handle("agent:token", (_e, token: unknown) => {
    if (token === undefined) return storedAgentToken() !== null;
    const before = envFingerprint();
    storeAgentToken(typeof token === "string" && token ? token : null);
    // Minting the credential while a session is already running is the common
    // case on a first launch, and that session cannot be handed it.
    if (envFingerprint() !== before) announceEnvChange();
    return storedAgentToken() !== null;
  });

  /** Is this pty still the right one for the workspace the window is in? */
  ipcMain.handle("term:stale", (_e, { id }: { id: string }) => {
    const t = terminals.get(id);
    return t ? t.startedWith !== envFingerprint() : false;
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

  ipcMain.handle("project:get", () => {
    const dir = projectRoot();
    return {
      dir,
      chosen: storedProject() !== null,
      packaged: app.isPackaged,
      server: storedServer(),
      config: readProjectConfig(dir),
      isRepo: looksLikeRepo(dir),
    };
  });

  /**
   * Open the picker and report what is there — without binding anything.
   *
   * Separate from the binding on purpose. A folder may already carry a
   * pointer to a different workspace, and that has to be shown to a person
   * before it is acted on in either direction. Choosing is a question; the
   * answer is project:bind.
   */
  ipcMain.handle("project:pick", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts = {
      title: "Choose the folder this workspace's code lives in",
      properties: ["openDirectory", "createDirectory"] as const,
      defaultPath: projectRoot(),
    };
    const res = win
      ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
      : await dialog.showOpenDialog({ properties: [...opts.properties] });
    const dir = res.canceled ? null : (res.filePaths[0] ?? null);
    if (!dir) return { dir: null, cancelled: true };
    return { dir, cancelled: false, config: readProjectConfig(dir), isRepo: looksLikeRepo(dir) };
  });

  /**
   * Bind a folder to the workspace this window is signed in to, and
   * optionally leave the pointer behind for whoever clones it next.
   */
  ipcMain.handle(
    "project:bind",
    (_e, { dir, write, workspace }: { dir: string; write?: boolean; workspace?: string }) => {
      if (typeof dir !== "string" || !dir || !existsSync(dir)) {
        return { ok: false, error: "That folder does not exist." };
      }
      const before = envFingerprint();
      storeProject(dir);
      const server = storedServer();
      let wrote = false;
      if (write && server) {
        try {
          writeProjectConfig(dir, { server, ...(workspace ? { workspace } : {}) });
          wrote = true;
        } catch (e) {
          // Worth reporting and not worth failing the binding over: the folder
          // is bound either way, the file is a convenience for other people.
          return { ok: true, dir, wrote: false, error: (e as Error).message };
        }
      }
      // A running pty cannot be moved to a new cwd, so the panes need to hear
      // that they are now in the wrong place.
      if (envFingerprint() !== before) announceEnvChange();
      return { ok: true, dir, wrote };
    },
  );

  // Kept for the Settings panel, which asks and binds in one motion.
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
    const before = envFingerprint();
    storeProject(res.filePaths[0]);
    if (envFingerprint() !== before) announceEnvChange();
    // Existing shells keep their old cwd; a pty cannot be moved. New ones pick
    // the change up, and the UI says so.
    return {
      dir: res.filePaths[0],
      changed: true,
      config: readProjectConfig(res.filePaths[0]),
      isRepo: looksLikeRepo(res.filePaths[0]),
    };
  });

  /** Which agent the Agent pane runs, and what is available to choose. */
  /**
   * Whether the agent can actually reach this workspace, and the means to fix
   * it when it cannot.
   *
   * An agent CLI finds its MCP servers through a config file in the folder it
   * is run from. If the project folder has none — which is every folder
   * except this repository — the agent starts fine, answers from nothing, and
   * never says why. So the answer is reported, and writing it is one button.
   */
  ipcMain.handle("agent:mcp", (_e, action: unknown) => {
    const dir = projectRoot();
    const file = join(dir, ".mcp.json");
    const server = storedServer() ?? projectEnv()["BULLETZ_SERVER_URL"] ?? "";

    const read = () => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as {
          mcpServers?: Record<string, { args?: unknown; env?: Record<string, string> }>;
        };
      } catch {
        return null;
      }
    };

    /**
     * Connected means the agent will actually get a bridge, not that a key
     * named "bulletz" is present.
     *
     * The weaker check cost real debugging time: this repository has a
     * checked-in .mcp.json from before the bundle existed, pointing at a path
     * that resolves in a source checkout and nowhere else. The panel reported
     * "connected", the agent found no bridge, and nothing in between said so.
     * So follow the entry to the file it names and see whether it is there.
     */
    const points = (entry: { args?: unknown } | undefined) => {
      if (!entry) return false;
      const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [];
      if (args.length === 0) return false;
      return args.some((a) => existsSync(isAbsolute(a as string) ? (a as string) : join(dir, a as string)));
    };

    // Same reasoning as the terminal: a config file written into whatever
    // folder we happened to guess is litter in someone's home directory.
    if (action === "connect" && !projectPicked()) {
      return {
        dir,
        file,
        exists: false,
        connected: false,
        needsProject: true,
        server,
        command: process.execPath,
        bundle: MCP_BUNDLE,
        bundleExists: existsSync(MCP_BUNDLE),
      };
    }

    if (action === "connect") {
      const existing = read() ?? {};
      const servers = existing.mcpServers ?? {};
      // Run through Electron's own node, so the user does not need node
      // installed for the bridge to work. The token is referenced rather than
      // written: a project folder is often a git repository, and a credential
      // on disk there is one `git add .` from being published.
      servers["bulletz"] = {
        command: process.execPath,
        args: [MCP_BUNDLE],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          // The env wins, the written value is the fallback. Baking the URL
          // outright made the file wrong the moment someone switched
          // workspace — it named whichever one was open when Connect was
          // clicked, in a file that lives in a repository. The app supplies
          // the variable at spawn; an agent launched from a plain terminal
          // still has something to fall back to.
          BULLETZ_SERVER_URL: server ? `\${BULLETZ_SERVER_URL:-${server}}` : "${BULLETZ_SERVER_URL}",
          BULLETZ_TOKEN: "${BULLETZ_TOKEN}",
        },
      } as never;
      writeFileSync(file, JSON.stringify({ ...existing, mcpServers: servers }, null, 2) + "\n");
    }

    const cfg = read();
    return {
      dir,
      file,
      exists: existsSync(file),
      needsProject: !projectPicked(),
      connected: points(cfg?.mcpServers?.["bulletz"]),
      server,
      command: process.execPath,
      bundle: MCP_BUNDLE,
      bundleExists: existsSync(MCP_BUNDLE),
    };
  });

  ipcMain.handle("agent:command", (_e, patch: unknown) => {
    if (patch !== undefined) {
      const p = patch as Partial<AgentCommand> | null;
      storeAgentCommand(
        p && typeof p.command === "string" && p.command.trim()
          ? { command: p.command.trim(), args: Array.isArray(p.args) ? p.args.map(String) : [] }
          : null,
      );
    }
    return {
      configured: storedAgentCommand(),
      resolved: resolveAgentCommand(),
      presets: AGENT_PRESETS.map((x) => ({ ...x, installed: onPath(x.cmd.command) })),
    };
  });

  ipcMain.handle("server:get", () => storedServer());
  ipcMain.handle("server:set", (_e, url: unknown) => {
    const before = envFingerprint();
    storeServer(typeof url === "string" && url ? url : null);
    // Staleness used to be decided once, when a pane mounted. That is too
    // early: switching workspace reloads the renderer, the panes reattach
    // immediately, and this call only arrives afterwards — once /me has come
    // back and told the window which workspace it is in. So every running
    // session was judged against the workspace it was already in and declared
    // current. Say when the ground moves, and let the panes re-ask.
    if (envFingerprint() !== before) announceEnvChange();
    return storedServer();
  });


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
