import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Decision, Event, Task, Thread } from "@bulletz/shared";
import { Api, type Constraint, type Presence, type Project } from "./api.ts";
import { TerminalPane, bridge, type AgentPolicy, type AgentRunEvent } from "./Terminal.tsx";
import { Widget, type WidgetRow } from "./Widget.tsx";
import { Apps } from "./Apps.tsx";

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
  const [me, setMe] = useState<{ id: string; handle: string; kind: string } | null>(null);
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

function Workspace({ api, me }: { api: Api; me: { id: string; handle: string; kind: string } }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [constraints, setConstraints] = useState<Constraint[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [widgets, setWidgets] = useState<WidgetRow[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [memOpen, setMemOpen] = useState(() => localStorage.getItem("bulletz.mem") !== "0");
  const [agentRun, setAgentRun] = useState<{ threadId: string; status: string } | null>(null);
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [surface, setSurface] = useState<"chat" | "apps">(
    () => (localStorage.getItem("bulletz.surface") as "chat" | "apps") ?? "chat",
  );
  const [connected, setConnected] = useState(false);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const refreshMemory = useCallback(async () => {
    const [d, c, t, p, w, proj] = await Promise.all([
      api.decisions(),
      api.constraints(),
      api.tasks(),
      api.presence(),
      api.widgets(),
      api.project(),
    ]);
    setProject(proj);
    setDecisions(d.decisions);
    setConstraints(c.constraints);
    setTasks(t.tasks);
    setPresence(p.presence);
    setWidgets(w.widgets as WidgetRow[]);
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
            setEvents((prev) => {
              if (prev.some((p) => p.id === ev.id)) return prev;
              // A revision supersedes the event it points at, in place, so an
              // edit does not jump the message to the bottom of the thread.
              if (ev.revision_of) {
                const idx = prev.findIndex((p) => p.id === ev.revision_of);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = ev;
                  return next;
                }
              }
              return [...prev, ev];
            });
          }
          setThreads((prev) =>
            prev
              .map((t) => (t.id === ev.thread_id ? { ...t, last_event_at: ev.created_at } : t))
              .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at)),
          );
        } else if (type === "thread") {
          const th = m["thread"] as unknown as Thread;
          setThreads((prev) => (prev.some((p) => p.id === th.id) ? prev : [th, ...prev]));
        } else if (type === "decision" || type === "task" || type === "presence" || type === "widget") {
          void refreshMemory();
        }
      },
      () => setConnected(true),
      () => setConnected(false),
    );
    return () => ws.close();
  }, [api, refreshMemory]);

  // Live status of a chat-triggered agent turn. The transcript itself arrives
  // as ordinary events over the WebSocket, because the adapter posts it into
  // the thread — so teammates see the work, not just the person who asked.
  useEffect(() => {
    const b = bridge();
    if (!b?.agent) return;
    void b.agent.policy().then(setPolicy);
    return b.agent.onEvent((threadId, e: AgentRunEvent) => {
      const status =
        e.type === "start" ? `running · ${e.model}`
        : e.type === "tool" ? `${e.name}…`
        : e.type === "text" ? "writing…"
        : e.type === "end" ? `done${e.costUsd ? ` · $${e.costUsd.toFixed(3)}` : ""}`
        : e.type === "error" ? `error: ${e.message.slice(0, 90)}`
        : "working…";
      setAgentRun({ threadId, status });
      if (e.type === "end" || e.type === "error") setTimeout(() => setAgentRun(null), 6000);
    });
  }, []);

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
    const about = /^\/about\s+([\s\S]+)/.exec(text);
    const link = /^\/link\s+(\S+)\s+(\S+)\s+(https?:\/\/\S+)(?:\s+--\s+([\s\S]+))?/.exec(text);

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
    } else if (about?.[1]) {
      await api.setProjectSummary(about[1].trim());
    } else if (link) {
      await api.addProjectLink({
        kind: link[1]!,
        label: link[2]!,
        url: link[3]!,
        ...(link[4] ? { notes: link[4].trim() } : {}),
      });
    } else if (/^@agent\s+/.test(text)) {
      // Post the ask first, so the record shows who asked what even if local
      // policy refuses the run or the agent fails.
      await api.postMessage(activeId, text);
      const prompt = text.replace(/^@agent\s+/, "").trim();
      const b = bridge();
      if (!b?.agent) {
        await api.postMessage(activeId, "_Agent runs need the desktop app._");
      } else {
        const r = await b.agent.run(activeId, prompt, true);
        if (!r.ok) await api.postMessage(activeId, `_Agent not started: ${r.error}_`);
      }
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
        <div className="nav">
          {(["chat", "apps"] as const).map((s) => (
            <button
              key={s}
              className={`nav-btn${surface === s ? " active" : ""}`}
              onClick={() => {
                setSurface(s);
                localStorage.setItem("bulletz.surface", s);
              }}
            >
              {s === "chat" ? "Chat" : "Apps"}
            </button>
          ))}
        </div>
        <span className="sep" />
        <div className="conn">
          <span className={`conn-dot${connected ? " on" : ""}`} />
          {connected ? "live" : "offline"} · {me.handle}
        </div>
      </div>

      <div
        className={`${surface === "apps" ? "panes panes-apps" : "panes"}${memOpen ? "" : " mem-collapsed"}`}
      >
        {surface === "apps" ? (
          <Apps api={api} tasks={tasks} widgets={widgets} onChange={refreshMemory} />
        ) : (
        <>
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

        <div className="pane">
          <div className="pane-head">{active?.title ?? "No thread"}</div>
          <div className="pane-body">
            <Stream events={events} widgets={widgets} api={api} me={me} onChange={refreshMemory} />
          </div>
          {agentRun?.threadId === activeId && (
            <div className="agent-strip">
              <span className="agent-dot" />
              <span>agent · {agentRun.status}</span>
              <button
                className="icon-btn"
                title="Stop this run"
                onClick={() => void bridge()?.agent?.stop(activeId!)}
              >
                ■
              </button>
            </div>
          )}
          <Composer disabled={!activeId} onSubmit={submit} policy={policy} onPolicy={setPolicy} />
        </div>
        </>

        )}

        <div className="pane mem-pane">
          <div className="pane-head">
            {memOpen && "Project memory"}
            <button
              className="icon-btn"
              title={memOpen ? "Collapse" : "Expand project memory"}
              onClick={() => {
                setMemOpen((v) => {
                  localStorage.setItem("bulletz.mem", v ? "0" : "1");
                  return !v;
                });
              }}
            >
              {memOpen ? "›" : "‹"}
            </button>
          </div>
          <div className="pane-body" hidden={!memOpen}>
            <ProjectCard project={project} />
            <Memory decisions={decisions} constraints={constraints} tasks={tasks} />
            <WidgetPanel widgets={widgets} api={api} onChange={refreshMemory} />
          </div>
        </div>
      </div>

      {/* Workbench-level, outside the surface switch: unmounting the terminal
          kills its pty, so a running job must survive Chat <-> Apps. */}
      <TerminalDock />
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

function Stream({
  events,
  widgets,
  api,
  me,
  onChange,
}: {
  events: Event[];
  widgets: WidgetRow[];
  api: Api;
  me: { id: string };
  onChange: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  return (
    <div className="stream">
      {events.length === 0 && <div className="empty">Nothing in this thread yet.</div>}
      {events.map((e) => {
        if (e.kind === "message_deleted") {
          return (
            <div className="msg tombstone" key={e.id}>
              <div className="avatar ghost">—</div>
              <div className="msg-main">
                <div className="msg-head">
                  <span className="msg-who">{e.actor_handle}</span>
                  <span className="msg-time">{time(e.created_at)}</span>
                </div>
                <div className="msg-deleted">message deleted</div>
              </div>
            </div>
          );
        }
        if (e.kind === "message") {
          return <Message key={e.id} e={e} mine={e.actor_id === me.id} api={api} />;
        }
        if (false as boolean) {
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
        if (e.kind === "widget") {
          const wid = (e.payload as { widget_id?: string }).widget_id;
          const w = widgets.find((x) => x.id === wid);
          if (w)
            return (
              <div key={e.id} className="stream-widget">
                <WidgetWithGate widget={w} api={api} onChange={onChange} />
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


/** A draft widget shows its activation gate inline: an agent authored it, a
 *  human decides whether it runs. */
function WidgetWithGate({
  widget,
  api,
  onChange,
}: {
  widget: WidgetRow;
  api: Api;
  onChange: () => void;
}) {
  const activate = async () => {
    if (widget.tool_id && widget.tool_status !== "active") await api.activateTool(widget.tool_id);
    await api.activateWidget(widget.id);
    onChange();
  };
  return (
    <>
      <Widget widget={widget} api={api} />
      {widget.status === "draft" && (
        <div className="widget-approve">
          <span>
            Authored by {widget.created_by_handle}
            {widget.tool_name ? ` · tool ${widget.tool_name}` : ""}
          </span>
          <button className="widget-activate" onClick={() => void activate()}>
            Activate
          </button>
        </div>
      )}
    </>
  );
}

function WidgetPanel({
  widgets,
  api,
  onChange,
}: {
  widgets: WidgetRow[];
  api: Api;
  onChange: () => void;
}) {
  const pinned = widgets.filter((w) => w.pinned || w.status === "active");
  return (
    <Section id="widgets" label="Widgets" count={widgets.length} defaultOpen={false}>
      {widgets.length === 0 && <div className="empty">none — agents publish these</div>}
      {pinned.map((w) => (
        <Widget key={w.id} widget={w} api={api} />
      ))}
      {widgets
        .filter((w) => w.status === "draft")
        .map((w) => (
          <WidgetWithGate key={w.id} widget={w} api={api} onChange={onChange} />
        ))}
    </Section>
  );
}


/** Project identity: what this is and where it lives. First thing in the
 *  memory pane because it is the first thing a new arrival needs, and the
 *  part a checkout cannot tell them. */

/** Collapsible, with the open/closed state kept per section. The memory pane
 *  grows without bound as a project accumulates; being able to fold a section
 *  away is what keeps it readable. */
function Section({
  id,
  label,
  count,
  children,
  defaultOpen = true,
}: {
  id: string;
  label: string;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const key = `bulletz.sec.${id}`;
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(key);
    return v === null ? defaultOpen : v === "1";
  });
  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(key, v ? "0" : "1");
      return !v;
    });
  };
  return (
    <div className="mem-group">
      <button className="mem-label mem-toggle" onClick={toggle} aria-expanded={open}>
        <span className={`chev${open ? " open" : ""}`}>›</span>
        {label}
        {count !== undefined && <span className="mem-count">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}

function ProjectCard({ project }: { project: Project | null }) {
  if (!project) return null;
  return (
    <Section id="project" label="Project">
      <div className="project-name">{project.name}</div>
      {project.summary ? (
        <div className="project-summary">{project.summary}</div>
      ) : (
        <div className="empty">no summary — try /about</div>
      )}
      {project.links.length > 0 && (
        <div className="project-links">
          {project.links.map((l) => (
            <a
              className="project-link"
              key={l.id}
              href={l.url}
              target="_blank"
              rel="noreferrer noopener"
              title={l.notes ?? l.url}
            >
              <span className="project-link-kind">{l.kind}</span>
              <span className="project-link-label">{l.label}</span>
            </a>
          ))}
        </div>
      )}
    </Section>
  );
}


/** A message, with its own revision controls. Edits and deletes are appended
 *  to the log as new events, so "edited" is a fact about the chain, not a
 *  mutation of the original. */
function Message({ e, mine, api }: { e: Event; mine: boolean; api: Api }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(e.body ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isAgent = e.actor_kind === "agent";

  // The confirm state reverts on its own: an armed Delete button left hanging
  // in a thread is a trap the next time someone reaches for the row.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && setConfirming(false);
    window.addEventListener("keydown", esc);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", esc);
    };
  }, [confirming]);
  const refs = [
    ...((e.refs.paths as string[] | undefined) ?? []),
    ...((e.refs.prs as string[] | undefined) ?? []),
  ];

  const save = async () => {
    const next = draft.trim();
    if (!next || next === e.body || busy) return setEditing(false);
    setBusy(true);
    try {
      await api.editMessage(e.id, next);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteMessage(e.id);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msg">
      <div className={`avatar${isAgent ? " agent" : ""}`}>{initials(e.actor_handle ?? "?")}</div>
      <div className="msg-main">
        <div className="msg-head">
          <span className={`msg-who${isAgent ? " agent" : ""}`}>{e.actor_handle}</span>
          {isAgent && <span className="badge">agent</span>}
          <span className="msg-time">{time(e.created_at)}</span>
          {e.edited && <span className="msg-edited" title="edited — earlier versions remain in the log">edited</span>}
          {mine && !editing && (
            <span className={`msg-actions${confirming ? " confirming" : ""}`}>
              {confirming ? (
                <>
                  <span className="confirm-ask">Delete this message?</span>
                  <button className="danger solid" autoFocus disabled={busy} onClick={() => void remove()}>
                    {busy ? "Deleting…" : "Delete"}
                  </button>
                  <button onClick={() => setConfirming(false)}>Cancel</button>
                </>
              ) : (
                <>
                  <button onClick={() => { setDraft(e.body ?? ""); setEditing(true); }}>Edit</button>
                  <button className="danger" onClick={() => setConfirming(true)}>Delete</button>
                </>
              )}
            </span>
          )}
        </div>

        {editing ? (
          <div className="msg-edit">
            <textarea
              autoFocus
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && !ev.shiftKey) {
                  ev.preventDefault();
                  void save();
                }
                if (ev.key === "Escape") setEditing(false);
              }}
            />
            <div className="msg-edit-bar">
              <button className="send" onClick={() => void save()} disabled={busy}>Save</button>
              <button onClick={() => setEditing(false)}>Cancel</button>
              <span className="msg-edit-hint">Enter to save · Esc to cancel</span>
            </div>
          </div>
        ) : (
          <div className="msg-body">{e.body}</div>
        )}

        {refs.length > 0 && !editing && (
          <div className="msg-refs">
            {refs.map((r) => (
              <span className="ref" key={r}>{r}</span>
            ))}
          </div>
        )}
      </div>
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
      <Section id="constraints" label="Constraints" count={constraints.length}>
        {constraints.length === 0 && <div className="empty">none — try /constrain</div>}
        {constraints.map((c) => (
          <div className="card constraint" key={c.id}>
            <div className="card-text">{c.rule}</div>
            {c.rationale && <div className="card-why">{c.rationale}</div>}
          </div>
        ))}
      </Section>

      <Section id="decisions" label="Decisions" count={decisions.length}>
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
      </Section>

      <Section id="work" label="Open work" count={open.length}>
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
      </Section>
    </>
  );
}

function Composer({
  disabled,
  onSubmit,
  policy,
  onPolicy,
}: {
  disabled: boolean;
  onSubmit: (text: string) => Promise<void>;
  policy: AgentPolicy | null;
  onPolicy: (p: AgentPolicy) => void;
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
          placeholder={
            disabled ? "Select a thread" : "Message, @agent to run, or /decide · /constrain · /task"
          }
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
        <code>@agent</code> prompt · <code>/decide</code> stmt -- why ·{" "}
        <code>/constrain</code> rule -- why · <code>/task</code> title ·{" "}
        <code>/about</code> summary · <code>/link</code> kind label url
        {policy && (
          <button
            className={`policy-chip${policy.enabled ? " on" : ""}`}
            title={
              policy.enabled
                ? `Chat can start agent runs on this machine · cap $${policy.maxBudgetUsd} per turn`
                : "Chat-triggered agent runs are off on this machine"
            }
            onClick={() => {
              void bridge()
                ?.agent?.policy({ enabled: !policy.enabled })
                .then(onPolicy);
            }}
          >
            {policy.enabled ? `@agent on · $${policy.maxBudgetUsd}/turn` : "@agent off"}
          </button>
        )}
      </div>
    </div>
  );
}
