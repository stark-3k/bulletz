import { useCallback, useEffect, useRef, useState } from "react";
import type { Notification } from "@bulletz/shared";
import type { Api } from "./api.ts";
import { bridge } from "./Terminal.tsx";

/**
 * The bell, and what hangs off it.
 *
 * Deliberately one surface for two sources: the server's inbox (mentions,
 * replies, tasks, agents) and purely local news (a new version is out). They
 * are different in origin and identical in what a person wants from them —
 * "something I should look at" — and splitting them across two affordances
 * means one of them gets ignored.
 */

const KIND_MARK: Record<string, string> = {
  mention: "@",
  reply: "↩",
  task: "✓",
  agent: "◆",
  system: "•",
  update: "↑",
};

/** A locally-sourced notification, shaped like a server one so the list does
 *  not have to care which it is rendering. */
export type LocalNotification = Notification & { kind: "system"; local: true; url?: string };

export function NotificationBell({
  api,
  onOpenChannel,
  live,
  localItems,
  onDismissLocal,
}: {
  api: Api;
  onOpenChannel: (channelId: string, eventId: string | null) => void;
  /** Pushed in from the workspace socket so the bell does not poll. */
  live: Notification[];
  localItems: LocalNotification[];
  onDismissLocal: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.notifications();
      setItems(r.notifications);
      setUnread(r.unread);
    } catch {
      /* a failed poll is not worth a visible error in the chrome */
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Socket pushes land here; merge rather than refetch so a burst of mentions
  // does not become a burst of round trips.
  useEffect(() => {
    if (!live.length) return;
    setItems((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      const fresh = live.filter((n) => !seen.has(n.id));
      return fresh.length ? [...fresh, ...prev] : prev;
    });
    setUnread((u) => u + live.filter((n) => !n.read_at).length);
  }, [live]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const total = unread + localItems.length;

  // The dock badge should match the bell, including the local items.
  useEffect(() => {
    void bridge()?.notify?.badge?.(total);
  }, [total]);

  const openOne = async (n: Notification) => {
    if (!n.read_at) {
      setItems((prev) => prev.map((p) => (p.id === n.id ? { ...p, read_at: new Date().toISOString() } : p)));
      setUnread((u) => Math.max(0, u - 1));
      void api.markRead([n.id]).catch(() => void load());
    }
    if (n.channel_id) {
      onOpenChannel(n.channel_id, n.event_id);
      setOpen(false);
    }
  };

  const all = [...localItems, ...items];

  return (
    <div className="bell-wrap" ref={box}>
      <button
        className={`bell${total > 0 ? " has" : ""}${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={total > 0 ? `${total} unread` : "Notifications"}
        aria-label={total > 0 ? `Notifications, ${total} unread` : "Notifications"}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path
            d="M8 1.5a4 4 0 0 0-4 4v2.2L2.8 10.3a.5.5 0 0 0 .45.72h9.5a.5.5 0 0 0 .45-.72L12 7.7V5.5a4 4 0 0 0-4-4Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M6.3 12.4a1.8 1.8 0 0 0 3.4 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        {total > 0 && <span className="bell-count">{total > 99 ? "99+" : total}</span>}
      </button>

      {open && (
        <div className="menu notif-menu">
          <div className="notif-head">
            <strong>Notifications</strong>
            <span className="sep" />
            {unread > 0 && (
              <button
                className="linklike"
                onClick={() => {
                  setItems((prev) => prev.map((p) => ({ ...p, read_at: p.read_at ?? new Date().toISOString() })));
                  setUnread(0);
                  void api.markAllRead().catch(() => void load());
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="notif-list">
            {all.length === 0 && <p className="notif-empty">Nothing yet.</p>}
            {all.map((n) => {
              const isLocal = "local" in n;
              return (
                <button
                  key={n.id}
                  className={`notif${n.read_at || isLocal ? "" : " unread"}`}
                  onClick={() => {
                    if (isLocal) return;
                    void openOne(n);
                  }}
                >
                  <span className={`notif-mark ${isLocal ? "update" : n.kind}`}>
                    {KIND_MARK[isLocal ? "update" : n.kind] ?? "•"}
                  </span>
                  <span className="notif-main">
                    <span className="notif-title">{n.title}</span>
                    {n.body && <span className="notif-body">{n.body}</span>}
                    <span className="notif-when">{ago(n.created_at)}</span>
                  </span>
                  {isLocal && (
                    <span className="notif-actions">
                      {(n as LocalNotification).url && (
                        <a
                          className="ghost"
                          href={(n as LocalNotification).url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Download
                        </a>
                      )}
                      <span
                        className="ghost"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDismissLocal(n.id);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && onDismissLocal(n.id)}
                      >
                        Dismiss
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
