import { contextBridge, ipcRenderer } from "electron";

/** The only surface the renderer gets. contextIsolation is on and
 *  nodeIntegration is off, so the UI can never touch Node directly. */
/** Main's record of which server this install belongs to, read from the
 *  launch arguments so it is available synchronously on first paint. */
const initialServer =
  process.argv.find((a) => a.startsWith("--bulletz-server="))?.slice("--bulletz-server=".length) || null;

contextBridge.exposeInMainWorld("bulletz", {
  initialServer,
  isDesktop: true,
  term: {
    spawn: (id: string, cols: number, rows: number, kind?: "shell" | "agent") =>
      ipcRenderer.invoke("term:spawn", { id, cols, rows, kind }),
    write: (id: string, data: string) => ipcRenderer.send("term:write", { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send("term:resize", { id, cols, rows }),
    kill: (id: string) => ipcRenderer.send("term:kill", { id }),
    onData: (cb: (id: string, data: string) => void) => {
      const h = (_e: unknown, p: { id: string; data: string }) => cb(p.id, p.data);
      ipcRenderer.on("term:data", h);
      return () => ipcRenderer.removeListener("term:data", h);
    },
    onExit: (cb: (id: string, code: number) => void) => {
      const h = (_e: unknown, p: { id: string; exitCode: number }) => cb(p.id, p.exitCode);
      ipcRenderer.on("term:exit", h);
      return () => ipcRenderer.removeListener("term:exit", h);
    },
  },
  server: {
    get: () => ipcRenderer.invoke("server:get") as Promise<string | null>,
    set: (url: string | null) => ipcRenderer.invoke("server:set", url) as Promise<string | null>,
  },
  notify: {
    show: (n: { title: string; body?: string; channelId?: string }) =>
      ipcRenderer.invoke("notify:show", n) as Promise<boolean>,
    badge: (count: number) => ipcRenderer.invoke("notify:badge", count) as Promise<boolean>,
    onOpen: (cb: (channelId: string) => void) => {
      const h = (_e: unknown, channelId: string) => cb(channelId);
      ipcRenderer.on("notify:open", h);
      return () => ipcRenderer.removeListener("notify:open", h);
    },
  },
  appVersion: () => ipcRenderer.invoke("app:version") as Promise<string>,
  project: {
    get: () =>
      ipcRenderer.invoke("project:get") as Promise<{ dir: string; chosen: boolean; packaged: boolean }>,
    choose: () =>
      ipcRenderer.invoke("project:choose") as Promise<{ dir: string; changed: boolean }>,
  },
  agent: {
    command: (patch?: { command: string; args: string[] } | null) =>
      ipcRenderer.invoke("agent:command", patch) as Promise<{
        configured: { command: string; args: string[] } | null;
        resolved: { command: string; args: string[] } | null;
        presets: { id: string; label: string; cmd: { command: string; args: string[] }; installed: boolean }[];
      }>,
    setToken: (token: string | null) =>
      ipcRenderer.invoke("agent:token", token) as Promise<boolean>,
    hasToken: () => ipcRenderer.invoke("agent:token") as Promise<boolean>,
    mcp: (action?: "connect") =>
      ipcRenderer.invoke("agent:mcp", action) as Promise<{
        dir: string;
        file: string;
        exists: boolean;
        connected: boolean;
        server: string;
        bundle: string;
        bundleExists: boolean;
      }>,
  },
  screen: {
    sources: () =>
      ipcRenderer.invoke("screen:sources") as Promise<{
        sources?: { id: string; name: string; thumbnail: string; isScreen: boolean }[];
        error?: string;
        status?: string;
      }>,
    openSettings: () => ipcRenderer.invoke("screen:openSettings") as Promise<boolean>,
    pick: (id: string) => ipcRenderer.invoke("screen:pick", { id }) as Promise<boolean>,
  },
  onFullscreen: (cb: (full: boolean) => void) => {
    const h = (_e: unknown, full: boolean) => cb(full);
    ipcRenderer.on("window:fullscreen", h);
    return () => ipcRenderer.removeListener("window:fullscreen", h);
  },
  localStatus: () =>
    ipcRenderer.invoke("local:status") as Promise<{
      branch: string | null;
      dirty_files: number;
      cwd: string;
      machine: string;
    }>,
});
