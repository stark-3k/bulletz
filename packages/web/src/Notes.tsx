import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "@bulletz/shared";
import type { Api } from "./api.ts";

/** Notes. The workspace's prose surface — runbooks, investigations, the shape
 *  of a design before it hardens into a decision.
 *
 *  Two things make this different from the other apps here. It autosaves, so
 *  the editor holds a local draft rather than rendering straight from props:
 *  the note list is pushed over the WebSocket, and a broadcast of your own save
 *  landing mid-keystroke would otherwise rewind the textarea. And the draft is
 *  flushed on every exit path — switching notes, unmounting, closing the tab —
 *  because a debounce that only fires while you are still looking at the note
 *  is a debounce that loses the last thing you typed. */

type Draft = { id: string; title: string; body: string };
type SaveState = "idle" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 700;

export function Notes({
  api,
  notes,
  onChange,
}: {
  api: Api;
  notes: Note[];
  onChange: () => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [fresh, setFresh] = useState<Note | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // The pending write and its timer live in refs, not state: a flush has to be
  // callable from a cleanup function, which cannot see a re-rendered value.
  const pending = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Assigned below, once `all` exists: click handlers need the list including a
  // just-created note, which props do not have yet.
  const notesRef = useRef<Note[]>(notes);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    setSave("saving");
    try {
      await api.updateNote(p.id, { title: p.title, body: p.body });
      // Something typed while this request was in flight means we are not
      // actually settled yet — don't flash "saved" over an unsaved edit.
      setSave(pending.current ? "saving" : "saved");
      setErr("");
      // No onChange() here on purpose: the server broadcasts the saved row and
      // App merges it, so refetching the whole workspace per autosave would be
      // pure waste. The rarer paths below still refresh, since they move counts.
    } catch (e) {
      setErr((e as Error).message);
      setSave("error");
      // Keep the edit queued so the next keystroke (or an explicit flush)
      // retries it instead of silently dropping the text.
      pending.current = p;
    }
  }, [api]);

  const edit = (patch: Partial<Omit<Draft, "id">>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    setSave("idle");
  };

  const open = (id: string) => {
    if (id === sel) return;
    void flush();
    const n = notesRef.current.find((x) => x.id === id);
    if (!n) return;
    setSel(id);
    setDraft({ id: n.id, title: n.title, body: n.body });
    setSave("idle");
    setErr("");
  };

  // Land on something rather than an empty canvas. Guarded on `sel === null`
  // so this only ever runs before the first selection.
  useEffect(() => {
    if (sel !== null) return;
    const first = notes[0];
    if (!first) return;
    setSel(first.id);
    setDraft({ id: first.id, title: first.title, body: first.body });
  }, [notes, sel]);

  // Leaving the Apps surface unmounts this, so flush on the way out — the
  // request outlives the component. The beforeunload flush is best-effort
  // only: a browser is free to kill an in-flight fetch during teardown, which
  // is why the debounce is short rather than relying on this.
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      void flush();
    };
  }, [flush]);

  // A note created a moment ago is not in `notes` until onChange's refetch
  // lands. Splice it in so the list and the editor do not blink empty.
  const all = useMemo(
    () => (fresh && !notes.some((n) => n.id === fresh.id) ? [fresh, ...notes] : notes),
    [notes, fresh],
  );
  notesRef.current = all;

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return all.filter((n) => {
      if (!showArchived && n.status === "archived") return false;
      if (!needle) return true;
      return `${n.title}\n${n.body}`.toLowerCase().includes(needle);
    });
  }, [all, filter, showArchived]);

  const current = all.find((n) => n.id === sel) ?? null;

  const create = async () => {
    await flush();
    setErr("");
    try {
      const { note } = await api.createNote({});
      setFresh(note);
      onChange();
      setSel(note.id);
      setDraft({ id: note.id, title: note.title, body: note.body });
      setSave("idle");
      requestAnimationFrame(() => titleRef.current?.focus());
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const patch = async (id: string, p: Parameters<Api["updateNote"]>[1]) => {
    await flush();
    setErr("");
    try {
      await api.updateNote(id, p);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="notes">
      <div className="app-head">
        <span className="app-title">Notes</span>
        <span className="app-note">
          {shown.length} {showArchived ? "shown" : "active"} · autosaves · searchable by agents
        </span>
        <div className="notes-actions">
          <button
            className={`embed-pill${showArchived ? " active" : ""}`}
            onClick={() => setShowArchived((v) => !v)}
            title="Include archived notes in the list"
          >
            Archived
          </button>
          <button className="widget-activate" onClick={() => void create()}>
            + Note
          </button>
        </div>
      </div>

      {err && <div className="members-err">{err}</div>}

      <div className="notes-split">
        <div className="notes-list">
          <input
            className="notes-filter"
            value={filter}
            placeholder="Filter notes…"
            onChange={(e) => setFilter(e.target.value)}
          />
          {shown.length === 0 && (
            <div className="empty" style={{ padding: "8px 12px" }}>
              {notes.length === 0 ? "no notes yet" : "nothing matches"}
            </div>
          )}
          {shown.map((n) => (
            <button
              key={n.id}
              className={`note-item${n.id === sel ? " active" : ""}${
                n.status === "archived" ? " archived" : ""
              }`}
              onClick={() => open(n.id)}
            >
              <span className="note-item-title">
                {n.pinned && <span className="note-pin">★</span>}
                {n.title.trim() || firstLine(n.body) || "Untitled"}
              </span>
              <span className="note-item-meta">
                {ago(n.updated_at)}
                {n.updated_by_handle ? ` · ${n.updated_by_handle}` : ""}
                {n.status === "archived" ? " · archived" : ""}
              </span>
            </button>
          ))}
        </div>

        <div className="notes-editor">
          {!draft || !current ? (
            <div className="empty" style={{ padding: 18 }}>
              {notes.length === 0
                ? "No notes yet — “+ Note” starts one."
                : "Pick a note on the left."}
            </div>
          ) : (
            <>
              <div className="notes-bar">
                <input
                  ref={titleRef}
                  className="notes-title"
                  value={draft.title}
                  placeholder="Title"
                  onChange={(e) => edit({ title: e.target.value })}
                />
                <span className={`notes-save ${save}`}>
                  {save === "saving"
                    ? "saving…"
                    : save === "saved"
                      ? "saved"
                      : save === "error"
                        ? "save failed"
                        : ""}
                </span>
                <button
                  className={`embed-pill${current.pinned ? " active" : ""}`}
                  onClick={() => void patch(current.id, { pinned: !current.pinned })}
                  title="Pin to the top of the list"
                >
                  {current.pinned ? "★ Pinned" : "☆ Pin"}
                </button>
                <button
                  className="embed-pill"
                  onClick={() =>
                    void patch(current.id, {
                      status: current.status === "archived" ? "active" : "archived",
                    })
                  }
                >
                  {current.status === "archived" ? "Restore" : "Archive"}
                </button>
              </div>

              {current.status === "archived" && (
                <div className="notes-archived-hint">
                  Archived — hidden from the list and skipped by agent search. The text is kept.
                </div>
              )}

              <textarea
                className="notes-body"
                value={draft.body}
                placeholder="Write it down. Agents read this through search_context, so the plain words matter more than the formatting."
                spellCheck
                onChange={(e) => edit({ body: e.target.value })}
                onBlur={() => void flush()}
              />

              <div className="notes-foot">
                <span>
                  {current.created_by_handle ? `started by ${current.created_by_handle} · ` : ""}
                  {draft.body.length.toLocaleString()} chars
                </span>
                <span>edited {ago(current.updated_at)}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim());
  if (!line) return "";
  return line.trim().length > 60 ? `${line.trim().slice(0, 60)}…` : line.trim();
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
