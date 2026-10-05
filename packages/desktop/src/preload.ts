import { contextBridge, ipcRenderer } from "electron";

/** The only surface the renderer gets. contextIsolation is on and
 *  nodeIntegration is off, so the UI can never touch Node directly. */
contextBridge.exposeInMainWorld("bulletz", {
  isDesktop: true,
  term: {
    spawn: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke("term:spawn", { id, cols, rows }),
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
  agent: {
    run: (threadId: string, prompt: string, byOwner: boolean) =>
      ipcRenderer.invoke("agent:run", { threadId, prompt, byOwner }) as Promise<{ ok: boolean; error?: string }>,
    stop: (threadId: string) => ipcRenderer.invoke("agent:stop", { threadId }),
    status: (threadId: string) =>
      ipcRenderer.invoke("agent:status", { threadId }) as Promise<{ running: boolean }>,
    policy: (patch?: unknown) => ipcRenderer.invoke("agent:policy", patch),
    onEvent: (cb: (threadId: string, e: unknown) => void) => {
      const h = (_e: unknown, p: { threadId: string; event: unknown }) => cb(p.threadId, p.event);
      ipcRenderer.on("agent:event", h);
      return () => ipcRenderer.removeListener("agent:event", h);
    },
  },
  localStatus: () =>
    ipcRenderer.invoke("local:status") as Promise<{
      branch: string | null;
      dirty_files: number;
      cwd: string;
      machine: string;
    }>,
});
