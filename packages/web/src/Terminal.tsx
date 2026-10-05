import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/** Injected by the Electron preload. Absent in a browser, which is the whole
 *  feature detect: the terminal needs a real pty, so it is desktop-only. */
type Bridge = {
  isDesktop: true;
  term: {
    spawn: (id: string, cols: number, rows: number) => Promise<{ cwd: string; shell: string }>;
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    kill: (id: string) => void;
    onData: (cb: (id: string, data: string) => void) => () => void;
    onExit: (cb: (id: string, code: number) => void) => () => void;
  };
};

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
  const api = bridge();

  useEffect(() => {
    if (!api || !host.current) return;

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
      if (tid === id) setExited(code);
    });

    void api.term.spawn(id, term.cols, term.rows).then((info) => {
      if (!disposed) setCwd(info.cwd);
    });

    term.onData((d) => api.term.write(id, d));

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
      api.term.kill(id);
      term.dispose();
    };
  }, [api, id]);

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
        {exited !== null && <span className="term-exit">exited {exited}</span>}
      </div>
      <div className="term-host" ref={host} />
    </div>
  );
}
