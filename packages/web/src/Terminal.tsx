import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/** Injected by the Electron preload. Absent in a browser, which is the whole
 *  feature detect: the terminal needs a real pty, so it is desktop-only. */
type Bridge = {
  isDesktop: true;
  term: {
    spawn: (
      id: string,
      cols: number,
      rows: number,
    ) => Promise<{ cwd: string; shell: string; replay: string; reattached: boolean }>;
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    kill: (id: string) => void;
    onData: (cb: (id: string, data: string) => void) => () => void;
    onExit: (cb: (id: string, code: number) => void) => () => void;
  };
  server?: {
    get: () => Promise<string | null>;
    set: (url: string | null) => Promise<string | null>;
  };
  project?: {
    get: () => Promise<{ dir: string; chosen: boolean; packaged: boolean }>;
    choose: () => Promise<{ dir: string; changed: boolean }>;
  };
  agent?: {
    setToken?: (token: string | null) => Promise<boolean>;
    hasToken?: () => Promise<boolean>;
    run: (
      channelId: string,
      prompt: string,
      byOwner: boolean,
      actor?: { id: string; handle: string },
    ) => Promise<{ ok: boolean; error?: string }>;
    stop: (channelId: string) => Promise<boolean>;
    status: (channelId: string) => Promise<{ running: boolean }>;
    policy: (patch?: Partial<AgentPolicy>) => Promise<AgentPolicy>;
    onEvent: (cb: (channelId: string, e: AgentRunEvent) => void) => () => void;
    sessions: (actorId: string) => Promise<AgentSessionSummary[]>;
    session: (id: string, actorId: string) => Promise<AgentSession | null>;
  };
  onFullscreen?: (cb: (full: boolean) => void) => () => void;
  screen?: {
    sources: () => Promise<{
      sources?: { id: string; name: string; thumbnail: string; isScreen: boolean }[];
      error?: string;
      status?: string;
    }>;
    pick: (id: string) => Promise<boolean>;
    openSettings: () => Promise<boolean>;
  };
};

/** Owned by the machine, not the server: a teammate's message starting a shell
 *  on this laptop is remote code execution, so the laptop keeps its own veto. */
export type AgentPolicy = {
  enabled: boolean;
  triggerFrom: "owner" | "anyone";
  maxBudgetUsd: number;
  restrictOthers: boolean;
};

export type AgentSessionSummary = {
  id: string;
  actorId: string | null;
  actorHandle: string | null;
  channelId: string;
  /** Claude Code's own session id — `claude --resume <this>` reopens it. */
  sessionId: string | null;
  prompt: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
  costUsd: number | null;
  turns: number | null;
};

export type AgentSession = AgentSessionSummary & { events: AgentRunEvent[] };

export type AgentRunEvent =
  | { type: "start"; sessionId: string; model: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "end"; subtype: string; costUsd: number | null; turns: number | null }
  | { type: "error"; message: string };

export const bridge = (): Bridge | null =>
  (globalThis as unknown as { bulletz?: Bridge }).bulletz ?? null;

const THEME = {
  background: "#0d1017",
  foreground: "#e4e8f1",
  cursor: "#5b9cff",
  selectionBackground: "#243044",
  black: "#1a1f2e",
  red: "#ff6b6b",
  green: "#4fd1a5",
  yellow: "#ffb454",
  blue: "#5b9cff",
  magenta: "#b78cff",
  cyan: "#56c8d8",
  white: "#c7cedd",
  brightBlack: "#5b6478",
  brightRed: "#ff8787",
  brightGreen: "#6ee7b7",
  brightYellow: "#ffc777",
  brightBlue: "#82b1ff",
  brightMagenta: "#c9a9ff",
  brightCyan: "#7ddce8",
  brightWhite: "#f0f3f8",
};

export function TerminalPane({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [cwd, setCwd] = useState<string>("");
  const [exited, setExited] = useState<number | null>(null);
  const [reattached, setReattached] = useState(false);
  // Bumping this tears the view down and builds a fresh one, which is what a
  // restart is: the old pty is already gone, so spawn makes a new shell.
  const [generation, setGeneration] = useState(0);
  const api = bridge();
  // onData closes over the first render, so read the live value from a ref.
  const exitedRef = useRef<number | null>(null);
  exitedRef.current = exited;

  useEffect(() => {
    if (!api || !host.current) return;
    setExited(null);

    const term = new Xterm({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    let disposed = false;
    const offData = api.term.onData((tid, data) => {
      if (tid === id) term.write(data);
    });
    const offExit = api.term.onExit((tid, code) => {
      if (tid !== id) return;
      setExited(code);
      // Say so in the terminal, the way a terminal would.
      term.write(`\r\n\x1b[90m[process exited with code ${code} — press Enter to start a new shell]\x1b[0m\r\n`);
    });

    void api.term.spawn(id, term.cols, term.rows).then((info) => {
      if (disposed) return;
      setCwd(info.cwd);
      // Hand back the output this view missed, so a reload resumes the session
      // instead of staring at a blank screen with a live job behind it.
      if (info.replay) term.write(info.replay);
      setReattached(info.reattached);
    });

    term.onData((d) => {
      if (exitedRef.current !== null) {
        // The shell is gone; keystrokes would go nowhere. Enter restarts.
        if (d === "\r") setGeneration((g) => g + 1);
        return;
      }
      api.term.write(id, d);
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        api.term.resize(id, term.cols, term.rows);
      } catch {
        /* element detached mid-resize */
      }
    });
    ro.observe(host.current);

    return () => {
      disposed = true;
      ro.disconnect();
      offData();
      offExit();
      // Deliberately NOT killing the pty: this view is going away, the shell
      // is not. It is torn down only on an explicit kill or window close.
      term.dispose();
    };
  }, [api, id, generation]);

  if (!api) {
    return (
      <div className="term-unavailable">
        <div className="term-unavailable-title">Terminal requires the desktop app</div>
        <div className="term-unavailable-body">
          A real pty cannot run in a browser tab. Run <code>npm run dev:desktop</code> to get the
          terminal, with <code>BULLETZ_TOKEN</code> already in its environment so{" "}
          <code>claude</code> reaches this workspace.
        </div>
      </div>
    );
  }

  return (
    <div className="term-wrap">
      <div className="term-bar">
        <span className="term-dot" />
        <span className="term-cwd">{cwd || "starting…"}</span>
        {reattached && exited === null && <span className="term-reattached">reattached</span>}
        {exited !== null && (
          <>
            <span className="term-exit">exited {exited}</span>
            <button className="term-restart" onClick={() => setGeneration((g) => g + 1)}>
              Restart
            </button>
          </>
        )}
      </div>
      <div className="term-host" ref={host} />
    </div>
  );
}
