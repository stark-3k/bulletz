import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Decision, Event, Task, Thread } from "@bulletz/shared";
import { Api, type Constraint, type Presence } from "./api.ts";
import { TerminalPane, bridge } from "./Terminal.tsx";

const TOKEN_KEY = "bulletz.token";
const initials = (h: string) => h.replace(/^agent-/, "").slice(0, 2).toUpperCase();
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function App() {
  // VITE_BULLETZ_TOKEN is a local-development convenience only: it keeps the
  // dev server from stopping at the login screen. Never ship a build with it.
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_BULLETZ_TOKEN ?? "",
  );
  const [me, setMe] = useState<{ handle: string; kind: string } | null>(null);
  const [authErr, setAuthErr] = useState("");

  const api = useMemo(() => (token ? new Api(token) : null), [token]);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api
      .me()
      .then((r) => live && setMe(r.actor))
      .catch((e: Error) => {
        if (!live) return;
        setAuthErr(e.message);
        setMe(null);
        localStorage.removeItem(TOKEN_KEY);
        setToken("");
      });
    return () => {
      live = false;
    };
  }, [api]);

  if (!api || !me) {
    return (
      <Auth
        error={authErr}
        onSubmit={(t) => {
          setAuthErr("");
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }
  return <Workspace api={api} me={me} />;
}

function Auth({ error, onSubmit }: { error: string; onSubmit: (t: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="auth">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h1>
          <span className="logo-dot" /> bulletz
        </h1>
        <p>The context layer for local coding agents.</p>
        {error && <div className="auth-err">{error}</div>}
        <label htmlFor="tok">Workspace token</label>
        <input
          id="tok"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="blz_h_…"
          autoFocus
        />
        <button className="send" type="submit" disabled={!value.trim()}>
          Connect
        </button>
        <div className="auth-note">npm run seed -w @bulletz/server</div>
      </form>
    </div>
  );
}

function Workspace({ api, me }: { api: Api; me: { handle: string; kind: string } }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [constraints, setConstraints] = useState<Constraint[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [connected, setConnected] = useState(false);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const refreshMemory = useCallback(async () => {
    const [d, c, t, p] = await Promise.all([
      api.decisions(),
      api.constraints(),
      api.tasks(),
      api.presence(),
    ]);
    setDecisions(d.decisions);
    setConstraints(c.constraints);
    setTasks(t.tasks);
    setPresence(p.presence);
  }, [api]);

  useEffect(() => {
    void (async () => {
      const { threads } = await api.threads();
      setThreads(threads);
      if (threads[0]) setActiveId(threads[0].id);
      await refreshMemory();
    })();
  }, [api, refreshMemory]);

  useEffect(() => {
    if (!activeId) return;
    void api.threadEvents(activeId).then((r) => setEvents(r.events));
  }, [api, activeId]);

  // Realtime: the log is pushed, so every client and agent sees the same
  // workspace without polling.
  useEffect(() => {
    const ws = api.stream(
      (raw) => {
        const m = raw as Record<string, never>;
        const type = m["type"] as unknown as string;
        if (type === "event") {
          const ev = m["event"] as unknown as Event;
          if (ev.thread_id && ev.thread_id === activeRef.current) {
            setEvents((prev) => (prev.some((p) => p.id === ev.id) ? prev : [...prev, ev]));
          }
          setThreads((prev) =>
            prev
              .map((t) => (t.id === ev.thread_id ? { ...t, last_event_at: ev.created_at } : t))
              .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at)),
          );
        } else if (type === "thread") {
          const th = m["thread"] as unknown as Thread;
          setThreads((prev) => (prev.some((p) => p.id === th.id) ? prev : [th, ...prev]));
        } else if (type === "decision" || type === "task" || type === "presence") {
          void refreshMemory();
        }
      },
      () => setConnected(true),
      () => setConnected(false),
    );
    return () => ws.close();
  }, [api, refreshMemory]);

  const active = threads.find((t) => t.id === activeId) ?? null;

  const newThread = async () => {
    const title = prompt("Thread title");
    if (!title?.trim()) return;
    const { thread } = await api.createThread(title.trim());
    setThreads((p) => [thread, ...p]);
    setActiveId(thread.id);
  };

  /** Slash commands are how the decision log gets written by hand — the cheap
   *  version of extraction, and the thing the thesis test actually needs. */
  const submit = async (text: string) => {
    if (!activeId) return;
    const decide = /^\/decide\s+([\s\S]+)/.exec(text);
    const constrain = /^\/constrain\s+([\s\S]+)/.exec(text);
    const task = /^\/task\s+([\s\S]+)/.exec(text);

    if (decide?.[1]) {
      const [statement, ...why] = decide[1].split(/\s*--\s*/);
      await api.createDecision({
        statement: statement!.trim(),
        ...(why.length ? { rationale: why.join(" -- ").trim() } : {}),
        thread_id: activeId,
      });
    } else if (constrain?.[1]) {
      const [rule, ...why] = constrain[1].split(/\s*--\s*/);
      await api.createConstraint({
        rule: rule!.trim(),
        ...(why.length ? { rationale: why.join(" -- ").trim() } : {}),
      });
    } else if (task?.[1]) {
      await api.createTask({ title: task[1].trim(), thread_id: activeId });
    } else {
      await api.postMessage(activeId, text);
    }
    await refreshMemory();
  };

  return (
    <div className="app">
      <div className="titlebar">
        <div className="logo">
          <span className="logo-dot" />
          bulletz
        </div>
        <span className="sep" />
        <div className="conn">
          <span className={`conn-dot${connected ? " on" : ""}`} />
          {connected ? "live" : "offline"} · {me.handle}
        </div>
      </div>

      <div className="panes">
        <div className="pane">
          <div className="pane-head">
            Threads
            <button className="icon-btn" onClick={newThread} title="New thread">
              +
            </button>
          </div>
          <div className="pane-body">
            {threads.length === 0 && <div className="empty" style={{ padding: "8px 13px" }}>No threads yet</div>}
            {threads.map((t) => (
              <button
                key={t.id}
                className={`thread${t.id === activeId ? " active" : ""}`}
                onClick={() => setActiveId(t.id)}
              >
                <div className="thread-title">{t.title}</div>
                <div className="thread-meta">{time(t.last_event_at)}</div>
              </button>
            ))}
          </div>
          <div className="presence">
            <div className="mem-label">Workspace</div>
            {presence.length === 0 && <div className="empty">nobody connected</div>}
            {presence.map((p) => (
              <div className="presence-row" key={p.handle}>
                <span className={`presence-dot${p.online ? " on" : ""}`} />
                <span className={`presence-name${p.kind === "agent" ? " agent" : ""}`}>{p.handle}</span>
                <span className="presence-meta">
                  {p.branch ?? "—"}
                  {p.dirty_files ? ` ·${p.dirty_files}△` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="pane center-split">
          <div className="center-top">
            <div className="pane-head">{active?.title ?? "No thread"}</div>
            <div className="pane-body">
              <Stream events={events} />
            </div>
            <Composer disabled={!activeId} onSubmit={submit} />
          </div>
          <TerminalDock />
        </div>

        <div className="pane">
          <div className="pane-head">Project memory</div>
          <div className="pane-body">
            <Memory decisions={decisions} constraints={constraints} tasks={tasks} />
          </div>
        </div>
      </div>
    </div>
  );
}


/** The terminal is why this is a desktop app: a real pty cannot exist in a
 *  browser tab. Its shell inherits BULLETZ_TOKEN, so `claude` started here
 *  reaches this workspace through the repo's .mcp.json with no extra setup. */
function TerminalDock() {
  const [height, setHeight] = useState(() => Number(localStorage.getItem("bulletz.termH") ?? 260));
  const [open, setOpen] = useState(() => localStorage.getItem("bulletz.termOpen") !== "0");
  const [dragging, setDragging] = useState(false);
  const desktop = bridge() !== null;

  useEffect(() => localStorage.setItem("bulletz.termH", String(height)), [height]);
  useEffect(() => localStorage.setItem("bulletz.termOpen", open ? "1" : "0"), [open]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const next = window.innerHeight - e.clientY - 4;
      setHeight(Math.max(90, Math.min(next, window.innerHeight - 220)));
    };
    const up = () => setDragging(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging]);

  return (
    <>
      <div
        className={`term-resizer${dragging ? " dragging" : ""}`}
        onMouseDown={() => open && setDragging(true)}
      />
      <div className="term-panel" style={{ height: open ? height : 28 }}>
        <div className="pane-head" style={{ borderBottom: "none", paddingBottom: 6 }}>
          <div className="tab-row">
            <button className="tab active">Terminal</button>
          </div>
          <button className="icon-btn" onClick={() => setOpen((v) => !v)} title={open ? "Hide" : "Show"}>
            {open ? "\u2013" : "+"}
          </button>
        </div>
        {open && (desktop ? <TerminalPane id="main" /> : <TerminalPane id="main" />)}
      </div>
    </>
  );
}

function Stream({ events }: { events: Event[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  return (
    <div className="stream">
      {events.length === 0 && <div className="empty">Nothing in this thread yet.</div>}
      {events.map((e) => {
        if (e.kind === "message") {
          const isAgent = e.actor_kind === "agent";
          const refs = [
            ...((e.refs.paths as string[] | undefined) ?? []),
            ...((e.refs.prs as string[] | undefined) ?? []),
          ];
          return (
            <div className="msg" key={e.id}>
              <div className={`avatar${isAgent ? " agent" : ""}`}>{initials(e.actor_handle ?? "?")}</div>
              <div className="msg-main">
                <div className="msg-head">
                  <span className={`msg-who${isAgent ? " agent" : ""}`}>{e.actor_handle}</span>
                  {isAgent && <span className="badge">agent</span>}
                  <span className="msg-time">{time(e.created_at)}</span>
                </div>
                <div className="msg-body">{e.body}</div>
                {refs.length > 0 && (
                  <div className="msg-refs">
                    {refs.map((r) => (
                      <span className="ref" key={r}>
                        {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        }
        const why = (e.payload as { rationale?: string | null }).rationale;
        return (
          <div className={`sysev ${e.kind}`} key={e.id}>
            <span className="sysev-kind">{e.kind.replace("_", " ")}</span>
            <div className="sysev-body">
              {e.body}
              {why && <div className="sysev-why">why: {why}</div>}
              <div className="sysev-who">
                {e.actor_handle} · {time(e.created_at)}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function Memory({
  decisions,
  constraints,
  tasks,
}: {
  decisions: Decision[];
  constraints: Constraint[];
  tasks: Task[];
}) {
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  return (
    <>
      <div className="mem-group">
        <div className="mem-label">
          Constraints <span className="mem-count">{constraints.length}</span>
        </div>
        {constraints.length === 0 && <div className="empty">none — try /constrain</div>}
        {constraints.map((c) => (
          <div className="card constraint" key={c.id}>
            <div className="card-text">{c.rule}</div>
            {c.rationale && <div className="card-why">{c.rationale}</div>}
          </div>
        ))}
      </div>

      <div className="mem-group">
        <div className="mem-label">
          Decisions <span className="mem-count">{decisions.length}</span>
        </div>
        {decisions.length === 0 && <div className="empty">none — try /decide</div>}
        {decisions.map((d) => (
          <div
            className={`card decision${d.status === "superseded" ? " superseded" : ""}`}
            key={d.id}
          >
            <div className="card-text">{d.statement}</div>
            {d.rationale && <div className="card-why">{d.rationale}</div>}
            <div className="card-foot">
              {d.status === "superseded" && <span className="tag">superseded</span>}
              <span>{d.decided_by_handle ?? "?"}</span>
              <span>·</span>
              <span>{d.decided_at.slice(0, 10)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mem-group">
        <div className="mem-label">
          Open work <span className="mem-count">{open.length}</span>
        </div>
        {open.length === 0 && <div className="empty">nothing open</div>}
        {open.map((t) => (
          <div className="task" key={t.id}>
            <span className={`task-status ${t.status}`}>{t.status.replace("_", " ")}</span>
            <div className="task-title">
              {t.title}
              {t.labels.length > 0 && (
                <div className="task-labels">
                  {t.labels.map((l) => (
                    <span className="label" key={l}>
                      {l}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Composer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      setText("");
      if (ta.current) ta.current.style.height = "auto";
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? "Select a thread" : "Message, or /decide · /constrain · /task"}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="send" onClick={() => void send()} disabled={disabled || !text.trim() || busy}>
          Send
        </button>
      </div>
      <div className="composer-hint">
        <code>/decide</code> statement -- why · <code>/constrain</code> rule -- why ·{" "}
        <code>/task</code> title
      </div>
    </div>
  );
}
