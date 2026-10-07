import { useEffect, useRef, useState } from "react";
import { listAccounts, removeAccount, setActive, type Account } from "./accounts.ts";

/**
 * Which workspace this window is showing, and how to get to the others.
 *
 * Switching reloads rather than re-pointing the live socket, the caches and an
 * in-flight event stream at a different server. A workspace switch is exactly
 * the moment a clean slate is wanted, and the alternative is a long tail of
 * bugs where one workspace's data is briefly rendered under another's name.
 */
export function WorkspaceMenu({
  current,
  onAdd,
}: {
  current: { workspaceName: string; handle: string; serverUrl: string } | null;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) setAccounts(listAccounts());
  }, [open]);

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

  const all = accounts.length ? accounts : listAccounts();
  // With a single workspace this is a label, not a menu — nothing to switch to
  // and nothing to compare against, so it should not look like a control.
  const multiple = all.length > 1;

  return (
    <div className="ws-wrap" ref={box}>
      <button
        className={`ws-btn${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={current ? `${current.workspaceName} · ${current.handle} · ${host(current.serverUrl)}` : "Workspaces"}
      >
        <span className="ws-name">{current?.workspaceName ?? "Bulletz"}</span>
        {multiple && <span className="caret">▾</span>}
      </button>

      {open && (
        <div className="menu ws-menu">
          <div className="menu-head">
            <strong>Workspaces</strong>
            <span className="muted">{all.length === 1 ? "1 signed in" : `${all.length} signed in`}</span>
          </div>

          <div className="ws-list">
            {all.map((a) => {
              const isCurrent = current?.serverUrl === a.serverUrl && current?.handle === a.handle;
              return (
                <div key={a.id} className={`ws-item${isCurrent ? " current" : ""}`}>
                  <button
                    className="ws-pick"
                    onClick={() => {
                      if (isCurrent) {
                        setOpen(false);
                        return;
                      }
                      setActive(a.id);
                      location.reload();
                    }}
                  >
                    <span className="ws-item-name">{a.workspaceName}</span>
                    <span className="ws-item-meta">
                      {a.handle} · {host(a.serverUrl)}
                    </span>
                  </button>
                  <button
                    className="ws-leave"
                    title={`Sign out of ${a.workspaceName}`}
                    aria-label={`Sign out of ${a.workspaceName}`}
                    onClick={() => {
                      const next = removeAccount(a.id);
                      // Leaving the workspace you are looking at has to reload;
                      // leaving another one only changes this list.
                      if (isCurrent || !next) location.reload();
                      else setAccounts(listAccounts());
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>

          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            Add a workspace…
          </button>
        </div>
      )}
    </div>
  );
}

/** A full URL is noise in a list; the host is what distinguishes two
 *  workspaces that happen to share a name. */
function host(url: string): string {
  try {
    const u = new URL(url);
    return u.port && u.port !== "443" ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}
