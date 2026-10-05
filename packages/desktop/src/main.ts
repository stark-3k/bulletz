import { spawn as spawnPty, type IPty } from "node-pty";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
