import { useState } from "react";
import { probeServer, normaliseServer, resolveServer, setServer, savedServer, clearServer } from "./server.ts";
import { bridge } from "./Terminal.tsx";
import logoUrl from "../public/logo.svg";

/**
 * Where the app is pointed, shown on every sign-in screen.
 *
 * It has to work when the server is unreachable — that is the main reason
 * anyone opens it — so it never depends on a successful call to render.
 */
export function ServerPicker({ onChanged }: { onChanged: () => void }) {
  const current = resolveServer();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const apply = async () => {
    setBusy(true);
    setErr("");
    setOk("");
    const r = await probeServer(value);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setOk(r.needsSetup ? "Reachable — this server has no workspace yet." : "Reachable.");
    setServer(r.url);
    // On the desktop the agent and the MCP bridge run in the main process and
    // must reach the same server, so the choice has to cross over.
    await bridge()?.server?.set(r.url);
    // A different server means different identities, so the token in hand is
    // meaningless there. Reload clean rather than carrying it across.
    setTimeout(onChanged, 550);
  };

  if (!open) {
    return (
      <div className="server-bar">
        <span className="server-label">Server</span>
        <code className="server-url" title={current}>
          {pretty(current)}
        </code>
        <button type="button" className="server-change" onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="server-edit">
      <label htmlFor="srv">Server address</label>
      <div className="server-row">
        <input
          id="srv"
          value={value}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          // Pre-filled with the current server so you can see what you are
          // changing — but anyone opening this is replacing it, not appending
          // to it, so selecting the text makes the first keystroke do that.
          onFocus={(e) => e.currentTarget.select()}
          placeholder="bulletz.example.com"
          onChange={(e) => {
            setValue(e.target.value);
            setErr("");
            setOk("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void apply();
            }
          }}
        />
        <button type="button" className="send" disabled={busy || !value.trim()} onClick={() => void apply()}>
          {busy ? "…" : "Connect"}
        </button>
      </div>
      {err && <div className="server-err">{err}</div>}
      {ok && <div className="server-ok">{ok}</div>}
      <div className="server-hint">
        The machine running the Bulletz server. Plain hostnames get <code>https</code>;
        <code>localhost</code> gets <code>http</code>. Include a port if it is not the default.
      </div>
      <div className="server-actions">
        <button
          type="button"
          className="linklike"
          onClick={() => {
            setOpen(false);
            setErr("");
            setOk("");
            setValue(current);
          }}
        >
          Cancel
        </button>
        {savedServer() && (
          <button
            type="button"
            className="linklike"
            onClick={() => {
              clearServer();
              void bridge()?.server?.set(null);
              onChanged();
            }}
          >
            Reset to default
          </button>
        )}
      </div>
    </div>
  );
}

/** A full URL is noise on a sign-in card; the host is what identifies it. */
function pretty(url: string): string {
  try {
    const u = new URL(url);
    return u.port && u.port !== "443" ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

/**
 * Shown when the server cannot be reached at all. Previously this failure was
 * swallowed and the app rendered a sign-in form that could only ever fail,
 * with nothing on screen explaining why or offering a way out.
 */
export function Unreachable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <h1>
          <img className="logo-mark" src={logoUrl} alt="bulletz.ai" />
        </h1>
        <p>Cannot reach the server.</p>
        <div className="auth-err">{error}</div>
        <ServerPicker onChanged={onRetry} />
        <button className="send" onClick={onRetry} style={{ marginTop: 10 }}>
          Try again
        </button>
        <div className="auth-note">
          Running it locally? Start it with <code>npm run dev -w @bulletz/server</code>.
        </div>
      </div>
    </div>
  );
}


/**
 * First launch of a downloaded app.
 *
 * There is no sensible default here and pretending otherwise is worse than
 * asking: a packaged app loads over file://, so there is no origin to infer
 * from, and falling back to localhost only produces an error screen as the
 * very first thing a new user sees. So the first question is the real one.
 */
export function Connect({ onConnected }: { onConnected: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const go = async () => {
    setBusy(true);
    setErr("");
    const r = await probeServer(value);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setServer(r.url);
    await bridge()?.server?.set(r.url);
    onConnected();
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <h1>
          <img className="logo-mark" src={logoUrl} alt="bulletz.ai" />
        </h1>
        <p>Connect to your workspace.</p>

        <label htmlFor="connect-srv">Server address</label>
        <input
          id="connect-srv"
          value={value}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          placeholder="bulletz.your-team.com"
          onChange={(e) => {
            setValue(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void go();
            }
          }}
        />
        {err && <div className="auth-err">{err}</div>}
        {!err && value.trim() && (
          <div className="auth-note">
            Will connect to <code>{normaliseServer(value)}</code>
          </div>
        )}

        <button className="send" disabled={busy || !value.trim()} onClick={() => void go()}>
          {busy ? "Checking…" : "Connect"}
        </button>

        <div className="auth-note">
          Bulletz is self-hosted — this is the address of the server your team runs, not an
          account on bulletz.ai. Whoever set it up has it. Running one yourself? Try{" "}
          <button type="button" className="linklike" onClick={() => setValue("localhost:4000")}>
            localhost:4000
          </button>
          .
        </div>
      </div>
    </div>
  );
}
