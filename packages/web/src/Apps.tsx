import { useState } from "react";
import type { Task } from "@bulletz/shared";
import type { Api } from "./api.ts";
import { Widget, type WidgetRow } from "./Widget.tsx";

/** The apps surface. A widget pinned into a chat message is an attachment;
 *  an app gets the whole canvas. Built-ins live beside agent-published
 *  widgets because to the person using them there is no difference. */

const COLUMNS = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
] as const;

type AppId = { type: "builtin"; id: "board" | "registry" } | { type: "widget"; id: string };

export function Apps({
  api,
  tasks,
  widgets,
  onChange,
}: {
  api: Api;
  tasks: Task[];
  widgets: WidgetRow[];
  onChange: () => void;
}) {
  const [sel, setSel] = useState<AppId>({ type: "builtin", id: "board" });
  const active = widgets.filter((w) => w.status === "active");
  const isSel = (a: AppId) => sel.type === a.type && sel.id === a.id;

  return (
    <div className="apps">
      <div className="apps-rail">
        <div className="pane-head">Apps</div>
        <div className="pane-body">
          <button
            className={`app-item${isSel({ type: "builtin", id: "board" }) ? " active" : ""}`}
            onClick={() => setSel({ type: "builtin", id: "board" })}
          >
            <span className="app-glyph">▦</span>
            <span>
              Task board
              <span className="app-sub">{tasks.filter((t) => t.status !== "done").length} open</span>
            </span>
          </button>
          <button
            className={`app-item${isSel({ type: "builtin", id: "registry" }) ? " active" : ""}`}
            onClick={() => setSel({ type: "builtin", id: "registry" })}
          >
            <span className="app-glyph">⚙</span>
            <span>
              Tools &amp; widgets
              <span className="app-sub">{widgets.length} published</span>
            </span>
          </button>

          <div className="app-group-label">Published apps</div>
          {active.length === 0 && <div className="empty" style={{ padding: "4px 13px" }}>none active</div>}
          {active.map((w) => (
            <button
              key={w.id}
              className={`app-item${isSel({ type: "widget", id: w.id }) ? " active" : ""}`}
              onClick={() => setSel({ type: "widget", id: w.id })}
            >
              <span className="app-glyph">◧</span>
              <span>
                {w.view?.title ?? w.name}
                <span className="app-sub">{w.created_by_handle}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="apps-canvas">
        {sel.type === "builtin" && sel.id === "board" && (
          <TaskBoard api={api} tasks={tasks} onChange={onChange} />
        )}
        {sel.type === "builtin" && sel.id === "registry" && (
          <Registry api={api} widgets={widgets} onChange={onChange} />
        )}
        {sel.type === "widget" &&
          (() => {
            const w = widgets.find((x) => x.id === sel.id);
            return w ? (
              <div className="app-full">
                <Widget widget={w} api={api} />
              </div>
            ) : (
              <div className="empty" style={{ padding: 18 }}>widget not found</div>
            );
          })()}
      </div>
    </div>
  );
}

function TaskBoard({ api, tasks, onChange }: { api: Api; tasks: Task[]; onChange: () => void }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const move = async (id: string, status: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    await api.updateTask(id, status);
    onChange();
  };

  const add = async () => {
    if (!title.trim()) return;
    await api.createTask({ title: title.trim() });
    setTitle("");
    setAdding(false);
    onChange();
  };

  return (
    <div className="board">
      <div className="app-head">
        <span className="app-title">Task board</span>
        <span className="app-note">drag between columns · every move lands in the log</span>
        <button className="widget-activate" onClick={() => setAdding((v) => !v)}>
          + Task
        </button>
      </div>

      {adding && (
        <div className="board-add">
          <input
            autoFocus
            value={title}
            placeholder="Task title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button className="send" onClick={() => void add()} disabled={!title.trim()}>
            Add
          </button>
        </div>
      )}

      <div className="board-cols">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.key);
          return (
            <div
              key={col.key}
              className={`board-col${over === col.key ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(col.key);
              }}
              onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                // Read the id off dataTransfer, not component state: setState is
                // async, so a drag that starts and drops without an intervening
                // render would see a stale null. dataTransfer is the contract.
                const id = e.dataTransfer.getData("text/bulletz-task") || dragId;
                if (id) void move(id, col.key);
                setDragId(null);
              }}
            >
              <div className="board-col-head">
                {col.label}
                <span className="mem-count">{items.length}</span>
              </div>
              <div className="board-col-body">
                {items.map((t) => (
                  <div
                    key={t.id}
                    className={`board-card${dragId === t.id ? " dragging" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/bulletz-task", t.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragId(t.id);
                    }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <div className="board-card-title">{t.title}</div>
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
                ))}
                {items.length === 0 && <div className="board-empty">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Registry({
  api,
  widgets,
  onChange,
}: {
  api: Api;
  widgets: WidgetRow[];
  onChange: () => void;
}) {
  const activate = async (w: WidgetRow) => {
    if (w.tool_id && w.tool_status !== "active") await api.activateTool(w.tool_id);
    await api.activateWidget(w.id);
    onChange();
  };

  return (
    <div className="registry">
      <div className="app-head">
        <span className="app-title">Tools &amp; widgets</span>
        <span className="app-note">agents draft · a human activates</span>
      </div>
      <div className="registry-list">
        {widgets.length === 0 && <div className="empty" style={{ padding: 16 }}>nothing published yet</div>}
        {widgets.map((w) => (
          <div className="registry-row" key={w.id}>
            <div className="registry-main">
              <div className="registry-name">
                {w.view?.title ?? w.name}
                <span className={`registry-kind${w.kind === "html" ? " html" : ""}`}>
                  {w.kind === "html" ? "custom html" : (w.view?.type ?? "view")}
                </span>
                {w.status === "draft" && <span className="tag">draft</span>}
              </div>
              <div className="registry-meta">
                {w.created_by_handle}
                {w.tool_name ? ` · tool ${w.tool_name} (${w.tool_status})` : " · no tool"}
                {w.view?.refresh_ms ? ` · refresh ${Math.round(w.view.refresh_ms / 1000)}s` : ""}
              </div>
            </div>
            {w.status === "draft" ? (
              <button className="widget-activate" onClick={() => void activate(w)}>
                Activate
              </button>
            ) : (
              <span className="registry-ok">active</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
