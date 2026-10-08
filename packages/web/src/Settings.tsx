import { useCallback, useEffect, useState } from "react";
import type { Api, Member, SessionRow, TokenRow } from "./api.ts";
import { resolveServer } from "./server.ts";
import { bridge } from "./Terminal.tsx";
import { updateStatus, type UpdateStatus } from "./updates.ts";

type Tab = "account" | "agent" | "notifications" | "security" | "tokens";

const TABS: { id: Tab; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "agent", label: "Agent" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Security" },
  { id: "tokens", label: "API tokens" },
];

/**
 * Everything about *you*, in one place. Workspace administration (members,
 * roles, invites) stays in Apps → Members: that is about other people, and
 * mixing the two makes it easy to change the wrong person's role.
 */
export function Settings({
  api,
  me,
  onClose,
  onSignOut,
}: {
  api: Api;
  me: { id: string; handle: string; role: string };
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("account");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  // Esc closes: a modal that traps you is worse than no modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<string | void>) => {
    setErr("");
    setNote("");
    try {
      const msg = await fn();
      if (msg) setNote(msg);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Settings</strong>
          <span className="sep" />
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-tab${tab === t.id ? " active" : ""}`}
                onClick={() => {
                  setTab(t.id);
                  setErr("");
                  setNote("");
                }}
              >
                {t.label}
              </button>
            ))}
            <span className="sep" />
            <button className="settings-tab danger" onClick={onSignOut}>
              Sign out
            </button>
          </div>

          <div className="settings-pane">
            {err && <div className="form-err">{err}</div>}
            {note && <div className="form-note">{note}</div>}
            {tab === "account" && <Account api={api} me={me} run={run} />}
            {tab === "agent" && <AgentSettings run={run} />}
            {tab === "notifications" && <Notifications api={api} run={run} />}
            {tab === "security" && <Security api={api} run={run} onSignOut={onSignOut} />}
            {tab === "tokens" && <Tokens api={api} run={run} />}
          </div>
        </div>
      </div>
    </div>
  );
}

type Run = (fn: () => Promise<string | void>) => Promise<void>;

function Account({ api, me, run }: { api: Api; me: { handle: string; role: string }; run: Run }) {
  const [profile, setProfile] = useState<Member | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    void api.members().then(({ members }) => {
      const mine = members.find((m) => m.handle === me.handle);
      if (!mine) return;
      setProfile(mine);
      setName(mine.display_name);
      setEmail(mine.email ?? "");
    });
  }, [api, me.handle]);

  const dirty = profile && (name !== profile.display_name || email !== (profile.email ?? ""));

  return (
    <>
      <h4>Profile</h4>
      <label className="field">
        <span>Handle</span>
        <input value={me.handle} disabled />
        <em>Your handle credits everything you have already posted, so it does not change.</em>
      </label>
      <label className="field">
        <span>Display name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="optional — lets you sign in with it too"
        />
      </label>
      <div className="row">
        <button
          className="send"
          disabled={!dirty}
          onClick={() =>
            void run(async () => {
              const { actor } = await api.updateMe({
                display_name: name.trim(),
                email: email.trim() || null,
              });
              setProfile(actor);
              return "Profile saved.";
            })
          }
        >
          Save
        </button>
        <span className="muted">Role: {me.role}</span>
      </div>

      <h4 className="spaced">Connected to</h4>
      <p className="muted">
        <code className="server-inline">{resolveServer()}</code>
        <br />
        Sign out to point this app at a different server.
      </p>

      <ProjectFolder />
      <AppVersion />
    </>
  );
}

/** Desktop only: the folder the terminal opens in and the agent works in.
 *  Running from source this is the repo; an installed copy has no repo, so it
 *  has to be told — and until it is, it falls back to home. */
function ProjectFolder() {
  const [info, setInfo] = useState<{ dir: string; chosen: boolean; packaged: boolean } | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    void bridge()?.project?.get().then(setInfo);
  }, []);

  if (!info) return null;

  return (
    <>
      <h4 className="spaced">Project folder</h4>
      <p className="muted">
        Where the terminal opens and the agent reads and writes. Your agent also looks here for
        its <code>.mcp.json</code>.
      </p>
      <div className="row">
        <code className="server-inline">{info.dir}</code>
      </div>
      {!info.chosen && info.packaged && (
        <p className="muted warn">
          Not set yet, so this is your home folder. Pick the project you actually want the agent
          working in.
        </p>
      )}
      <div className="row">
        <button
          className="send"
          onClick={() =>
            void bridge()
              ?.project?.choose()
              .then((r) => {
                if (!r.changed) return;
                setInfo((v) => (v ? { ...v, dir: r.dir, chosen: true } : v));
                // A running shell cannot be moved to a new cwd, so say so
                // rather than letting the terminal quietly disagree.
                setNote("Saved. Open a new terminal for it to start there.");
              })
          }
        >
          Choose folder…
        </button>
        {note && <span className="muted">{note}</span>}
      </div>
    </>
  );
}

function Security({ api, run, onSignOut }: { api: Api; run: Run; onSignOut: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  const load = () => void api.sessions().then((r) => setSessions(r.sessions));
  useEffect(load, [api]);

  const mismatch = next.length > 0 && again.length > 0 && next !== again;
  const ready = next.length >= 10 && next === again;

  return (
    <>
      <h4>Change password</h4>
      <label className="field">
        <span>Current password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        <span>New password</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        <em>At least 10 characters.</em>
      </label>
      <label className="field">
        <span>Repeat new password</span>
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <em className="bad">Those do not match.</em>}
      </label>
      <div className="row">
        <button
          className="send"
          disabled={!ready}
          onClick={() =>
            void run(async () => {
              await api.changePassword(current || undefined, next);
              setCurrent("");
              setNext("");
              setAgain("");
              load();
              return "Password changed. Every other session was signed out.";
            })
          }
        >
          Change password
        </button>
      </div>

      <h4 className="spaced">Active sessions</h4>
      <p className="muted">
        Each browser or desktop window you have signed in from with a password. Revoking one signs
        that window out immediately.
      </p>
      <div className="rows">
        {sessions.map((s) => (
          <div key={s.id} className="rowitem">
            <div className="rowitem-main">
              <strong>{shortAgent(s.user_agent)}</strong>
              {s.current && <span className="pill">this window</span>}
              <span className="muted">
                {s.ip ?? "unknown ip"} · last used {ago(s.last_used_at ?? s.created_at)}
              </span>
            </div>
            <button
              className="ghost"
              onClick={() =>
                void run(async () => {
                  if (s.current) {
                    onSignOut();
                    return;
                  }
                  await api.revokeSession(s.id);
                  load();
                  return "Session revoked.";
                })
              }
            >
              {s.current ? "Sign out" : "Revoke"}
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          // Not an error state: an API token is not a session, so a client
          // signed in that way has nothing to list. Saying "none" alone reads
          // like something is broken.
          <p className="muted empty">
            You are signed in with an API token rather than a password, so there is no session to
            show here. Revoke it under <strong>API tokens</strong> to end this sign-in.
          </p>
        )}
      </div>
    </>
  );
}

function Tokens({ api, run }: { api: Api; run: Run }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  const load = () => void api.apiTokens().then((r) => setTokens(r.tokens));
  useEffect(load, [api]);

  return (
    <>
      <h4>API tokens</h4>
      <p className="muted">
        For scripts, CI, and agents that reach the workspace over MCP or HTTP. A token carries
        your permissions, so treat it like a password.
      </p>

      {fresh && (
        <div className="form-note code-note">
          <div>
            <strong>{fresh.name}</strong> — copy it now, it is not shown again.
          </div>
          <code>{fresh.token}</code>
          <button className="ghost" onClick={() => void navigator.clipboard.writeText(fresh.token)}>
            Copy
          </button>
        </div>
      )}

      <div className="row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What is it for? e.g. laptop agent"
          maxLength={80}
        />
        <button
          className="send"
          disabled={!name.trim()}
          onClick={() =>
            void run(async () => {
              const t = await api.createApiToken(name.trim());
              setFresh({ name: t.name, token: t.token });
              setName("");
              load();
            })
          }
        >
          Create
        </button>
      </div>

      <div className="rows">
        {tokens.map((t) => (
          <div key={t.id} className="rowitem">
            <div className="rowitem-main">
              <strong>{t.name}</strong>
              <span className="muted">
                {t.actor_handle} · created {ago(t.created_at)} ·{" "}
                {t.last_used_at ? `last used ${ago(t.last_used_at)}` : "never used"}
              </span>
            </div>
            <button
              className="ghost danger"
              onClick={() =>
                void run(async () => {
                  await api.revokeApiToken(t.id);
                  load();
                  return `"${t.name}" revoked.`;
                })
              }
            >
              Revoke
            </button>
          </div>
        ))}
        {tokens.length === 0 && <p className="muted">No tokens yet.</p>}
      </div>
    </>
  );
}

/** A full user-agent string is noise; the browser and platform are the signal. */
function shortAgent(ua: string | null): string {
  if (!ua) return "Unknown client";
  if (ua.includes("Electron")) return "Desktop app";
  const browser = /Firefox\/|Edg\/|Chrome\/|Safari\//.exec(ua)?.[0]?.replace(/\/$/, "");
  const os = /Mac OS X|Windows NT|Linux|iPhone|Android/.exec(ua)?.[0];
  return [browser === "Edg" ? "Edge" : browser, os].filter(Boolean).join(" · ") || "Unknown client";
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}


const KINDS: { id: string; label: string; hint: string }[] = [
  { id: "mention", label: "Mentions", hint: "Someone writes @your-handle" },
  { id: "reply", label: "Replies", hint: "Someone replies to a message you wrote" },
  { id: "task", label: "Tasks", hint: "A task is assigned to you" },
  { id: "agent", label: "Agent activity", hint: "Your agent posts the result of a run" },
];

/**
 * What is worth interrupting someone for.
 *
 * There is deliberately no "notify me about everything" switch. A channel
 * being busy is what the unread count beside its name is for; turning that
 * into notifications is how people learn to ignore the bell entirely.
 */
function Notifications({ api, run }: { api: Api; run: Run }) {
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [muted, setMuted] = useState<string[]>([]);
  const [channels, setChannels] = useState<{ id: string; title: string }[]>([]);
  const [desktopOk, setDesktopOk] = useState<boolean | null>(null);

  useEffect(() => {
    void api.notifyPrefs().then((r) => {
      setPrefs(r.prefs ?? {});
      setMuted(r.muted ?? []);
    });
    void api.channels().then((r) => setChannels(r.channels.map((c) => ({ id: c.id, title: c.title }))));
    setDesktopOk(Boolean(bridge()?.notify));
  }, [api]);

  if (!prefs) return null;
  // Absent means on, so a new notification kind is opt-out rather than missed.
  const on = (k: string) => prefs[k] !== false;

  const toggle = (k: string) =>
    void run(async () => {
      const next = !on(k);
      setPrefs((p) => ({ ...(p ?? {}), [k]: next }));
      await api.setNotifyPrefs({ [k]: next });
    });

  return (
    <>
      <h4>Notify me about</h4>
      <div className="rows">
        {KINDS.map((k) => (
          <div key={k.id} className="rowitem">
            <div className="rowitem-main">
              <strong>{k.label}</strong>
              <span className="muted">{k.hint}</span>
            </div>
            <button
              className={`toggle${on(k.id) ? " on" : ""}`}
              role="switch"
              aria-checked={on(k.id)}
              aria-label={k.label}
              onClick={() => toggle(k.id)}
            >
              <span className="toggle-knob" />
            </button>
          </div>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 10 }}>
        A channel simply being busy is not a notification — that is the count beside its name.
      </p>

      <h4 className="spaced">Desktop notifications</h4>
      {desktopOk ? (
        <p className="muted">
          Shown by the operating system when the app is in the background or you are looking at a
          different channel. Clicking one opens the message.
        </p>
      ) : (
        <p className="muted">
          Not available here — the browser tab shows the count in the bell instead. The desktop app
          can raise system notifications.
        </p>
      )}

      <h4 className="spaced">Muted channels</h4>
      <p className="muted">A muted channel never notifies, even if you are mentioned in it.</p>
      <div className="rows">
        {channels.map((c) => {
          const isMuted = muted.includes(c.id);
          return (
            <div key={c.id} className="rowitem">
              <div className="rowitem-main">
                <strong>{c.title}</strong>
              </div>
              <button
                className="ghost"
                onClick={() =>
                  void run(async () => {
                    await api.muteChannel(c.id, !isMuted);
                    setMuted((m) => (isMuted ? m.filter((x) => x !== c.id) : [...m, c.id]));
                  })
                }
              >
                {isMuted ? "Unmute" : "Mute"}
              </button>
            </div>
          );
        })}
        {channels.length === 0 && <p className="muted empty">No channels yet.</p>}
      </div>
    </>
  );
}


/**
 * What is running, and whether anything newer exists.
 *
 * Desktop only: the web UI is whatever the server is serving, so there is no
 * such thing as an out-of-date copy of it. Nothing here installs anything —
 * macOS refuses to auto-update an app without a Developer ID signature, and
 * these builds are ad-hoc signed, so an updater would work on Linux and
 * Windows and quietly fail on the platform most people use.
 */
function AppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async (v: string) => {
    setChecking(true);
    setStatus(await updateStatus(v));
    setChecking(false);
  }, []);

  useEffect(() => {
    const b = bridge();
    if (!b?.appVersion) return;
    void b.appVersion().then((v) => {
      setVersion(v);
      void check(v);
    });
  }, [check]);

  if (!version) return null;

  return (
    <>
      <h4 className="spaced">Version</h4>
      <div className="row">
        <code className="server-inline">{version}</code>
        {status?.state === "available" && <span className="pill">update available</span>}
      </div>

      {checking && <p className="muted">Checking…</p>}
      {!checking && status?.state === "current" && (
        <p className="muted">You are on the newest build.</p>
      )}
      {!checking && status?.state === "unknown" && <p className="muted">{status.reason}</p>}
      {!checking && status?.state === "available" && (
        <p className="muted">
          <strong>{status.latest.version}</strong> has been released. Builds are unsigned, so this
          is a download rather than an automatic update.
        </p>
      )}

      <div className="row">
        <button className="ghost" disabled={checking} onClick={() => void check(version)}>
          {checking ? "Checking…" : "Check again"}
        </button>
        {status?.state === "available" && (
          <a className="send" href={status.latest.url} target="_blank" rel="noreferrer">
            Get {status.latest.version}
          </a>
        )}
      </div>
    </>
  );
}


type AgentCmd = { command: string; args: string[] };
type AgentInfo = {
  configured: AgentCmd | null;
  resolved: AgentCmd | null;
  presets: { id: string; label: string; cmd: AgentCmd; installed: boolean }[];
};

/**
 * Which coding agent the Agent tab runs.
 *
 * Deliberately a command rather than a list of supported vendors. The whole
 * premise is that the workspace does not care which agent you use — it holds
 * the team's memory and hands it over through MCP — so anything that runs in
 * a terminal belongs here, including agents that do not exist yet.
 */
function AgentSettings({ run }: { run: Run }) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    const b = bridge();
    if (!b?.agent?.command) return;
    const r = await b.agent.command();
    setInfo(r);
    const cur = r.configured ?? r.resolved;
    setDraft(cur ? [cur.command, ...cur.args].join(" ") : "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!info) {
    return (
      <>
        <h4>Agent</h4>
        <p className="muted">
          The agent runs on your machine, so this is a desktop-app setting. The web UI has no
          terminal to run one in.
        </p>
      </>
    );
  }

  const save = (text: string) =>
    void run(async () => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      const b = bridge();
      await b?.agent?.command?.(parts.length ? { command: parts[0]!, args: parts.slice(1) } : null);
      await load();
      return parts.length ? `Agent set to ${parts[0]}.` : "Cleared — the first one found will be used.";
    });

  const active = info.configured ?? info.resolved;

  return (
    <>
      <h4>Coding agent</h4>
      <p className="muted">
        The Agent tab runs this command in a terminal, so you get that agent&apos;s own interface —
        interactive, and interruptible with Ctrl-C. It inherits the workspace&apos;s MCP config, so
        whatever you run can read the team&apos;s memory.
      </p>

      <div className="row">
        <code className="server-inline">
          {active ? [active.command, ...active.args].join(" ") : "none found"}
        </code>
        {!info.configured && active && <span className="muted">found on your PATH</span>}
      </div>

      <label className="field">
        <span>Command</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save(draft);
          }}
          placeholder="claude"
          spellCheck={false}
        />
        <em>Arguments are allowed. Leave empty to use whichever is found first.</em>
      </label>
      <div className="row">
        <button className="send" onClick={() => save(draft)}>
          Save
        </button>
        {info.configured && (
          <button className="ghost" onClick={() => save("")}>
            Reset
          </button>
        )}
      </div>

      <McpStatus />

      <h4 className="spaced">Found on this machine</h4>
      <div className="rows">
        {info.presets.map((p) => (
          <div key={p.id} className="rowitem">
            <div className="rowitem-main">
              <strong>{p.label}</strong>
              <span className="muted">{p.cmd.command}</span>
            </div>
            {p.installed ? (
              <button className="ghost" onClick={() => save([p.cmd.command, ...p.cmd.args].join(" "))}>
                Use
              </button>
            ) : (
              <span className="muted">not installed</span>
            )}
          </div>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        This list is a convenience, not a limit — type any command above.
      </p>
    </>
  );
}


/**
 * Can the agent actually see this workspace?
 *
 * The agent finds its MCP servers through a config file in the folder it runs
 * in. Without one it starts perfectly, answers from nothing, and never
 * explains why — which is the worst possible failure for something whose only
 * job is to know things.
 */
function McpStatus() {
  const [state, setState] = useState<{
    dir: string;
    file: string;
    exists: boolean;
    connected: boolean;
    server: string;
    bundleExists: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await bridge()?.agent?.mcp?.();
    if (r) setState(r);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;

  return (
    <>
      <h4 className="spaced">Workspace access</h4>
      {state.connected ? (
        <p className="muted">
          This project is connected. The agent can read the team&apos;s decisions, constraints and
          history through <code>context_pack</code>, and post answers back.
        </p>
      ) : (
        <p className="muted warn">
          The agent cannot see this workspace. It will start and answer from nothing, because
          nothing in <code>{state.dir}</code> tells it where the workspace is.
        </p>
      )}
      <div className="row">
        <code className="server-inline">{state.file}</code>
      </div>
      <p className="muted">
        Points at <code>{state.server || "the signed-in server"}</code>. The credential is
        referenced, not written — a project folder is usually a git repository, and a token on
        disk there is one commit from being published.
      </p>
      {!state.connected && (
        <div className="row">
          <button
            className="send"
            disabled={busy || !state.bundleExists}
            onClick={() => {
              setBusy(true);
              void bridge()
                ?.agent?.mcp?.("connect")
                .then((r) => r && setState(r))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "…" : "Connect this project"}
          </button>
          {!state.bundleExists && (
            <span className="muted">The bridge is missing from this build.</span>
          )}
        </div>
      )}
    </>
  );
}
