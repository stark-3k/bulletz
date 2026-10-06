import { useEffect, useMemo, useState } from "react";

/** The site app: bulletz.ai running inside the workspace canvas.
 *
 *  The frame is a different origin from the shell, so this is a viewport and
 *  not a browser — we cannot read the frame's location, observe its
 *  navigations, or drive its history. That rules out a back/forward pair, so
 *  the chrome offers only what actually works cross-origin: switch target,
 *  reload (by remounting the element), and leave for a real tab. */

const TARGETS = [
  { id: "production", label: "Production", url: import.meta.env.VITE_BULLETZ_SITE_URL ?? "https://bulletz.ai" },
  {
    id: "staging",
    label: "Staging",
    url: import.meta.env.VITE_BULLETZ_STAGING_URL ?? "https://staging.bulletz.ai",
  },
] as const;

const TARGET_KEY = "bulletz.embed.target";

export function Embed() {
  const [targetId, setTargetId] = useState<string>(
    () => localStorage.getItem(TARGET_KEY) ?? TARGETS[0].id,
  );
  // Bumped to force a fresh element, which is the only reload we can trigger
  // on a cross-origin frame — contentWindow.location.reload() would throw.
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const target = TARGETS.find((t) => t.id === targetId) ?? TARGETS[0];

  // allow-same-origin plus allow-scripts is only safe while the frame is a
  // different origin than the shell: then "same origin" means bulletz.ai's own
  // origin and the sandbox still walls off this page. If someone points the env
  // var at the dev server itself, that pairing would hand the frame full access
  // to the shell, so drop the token and let the frame run opaque instead.
  const sandbox = useMemo(() => {
    const tokens = ["allow-scripts", "allow-forms", "allow-popups", "allow-popups-to-escape-sandbox"];
    try {
      if (new URL(target.url).origin !== window.location.origin) tokens.push("allow-same-origin");
    } catch {
      /* an unparseable URL gets the strictest sandbox */
    }
    return tokens.join(" ");
  }, [target.url]);

  useEffect(() => setLoaded(false), [target.url, nonce]);

  return (
    <div className="embed">
      <div className="app-head">
        <span className="app-title">bulletz.ai</span>
        <span className="app-note">embedded · cross-origin, so no history controls</span>
        <div className="embed-actions">
          {TARGETS.map((t) => (
            <button
              key={t.id}
              className={`embed-pill${t.id === target.id ? " active" : ""}`}
              onClick={() => {
                setTargetId(t.id);
                localStorage.setItem(TARGET_KEY, t.id);
              }}
            >
              {t.label}
            </button>
          ))}
          <button className="embed-pill" onClick={() => setNonce((n) => n + 1)} title="Reload the frame">
            Reload
          </button>
          {/* A frame refused by X-Frame-Options still fires load in Chromium, so
              there is no reliable way to detect the blocked case and swap in a
              fallback. The escape hatch stays visible instead of conditional. */}
          <a className="embed-pill" href={target.url} target="_blank" rel="noreferrer noopener">
            Open in tab ↗
          </a>
        </div>
      </div>

      <div className="embed-bar">
        <span className="embed-lock">🔒</span>
        <span className="embed-url">{target.url}</span>
        {!loaded && <span className="embed-loading">loading…</span>}
      </div>

      <div className="embed-stage">
        <iframe
          key={`${target.url}#${nonce}`}
          className="embed-frame"
          src={target.url}
          title={`${target.label} — ${target.url}`}
          sandbox={sandbox}
          referrerPolicy="strict-origin-when-cross-origin"
          loading="eager"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
}
