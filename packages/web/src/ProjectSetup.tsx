/**
 * "Which folder does this workspace's code live in?", asked once, at the
 * point it can be answered.
 *
 * It used to be asked by failure: the terminal refused to start and offered a
 * picker, which is a fine backstop and a poor introduction. Signing in is the
 * moment someone knows the answer, so it is the moment to ask — and the
 * moment the binding can be written down for whoever clones the repository
 * next.
 *
 * Skippable on purpose. Plenty of people open this to read a channel, and a
 * folder picker in the way of that is a tax on the wrong person. The agent
 * still will not start without one; that gate stays.
 */
import { useCallback, useState } from "react";
import { bridge } from "./Terminal.tsx";
import { beginAddWorkspace } from "./accounts.ts";
import { setServer } from "./server.ts";

type Picked = { dir: string; config: { server: string; workspace?: string } | null; isRepo: boolean };

const SKIP_KEY = (server: string) => `bulletz.projectSkipped.${server}`;

export function hasSkippedProject(server: string): boolean {
  try {
    return localStorage.getItem(SKIP_KEY(server)) === "1";
  } catch {
    return false;
  }
}

function rememberSkip(server: string) {
  try {
    localStorage.setItem(SKIP_KEY(server), "1");
  } catch {
    /* a skip that is not remembered just asks again; nothing breaks */
  }
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function ProjectSetup({
  server,
  workspaceName,
  onDone,
}: {
  server: string;
  workspaceName: string;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = useCallback(() => {
    setErr(null);
    void bridge()
      ?.project?.pick?.()
      .then((r) => {
        if (!r || r.cancelled || !r.dir) return;
        setPicked({ dir: r.dir, config: r.config ?? null, isRepo: Boolean(r.isRepo) });
        // Offer to leave a pointer where it would reach someone. Outside a
        // repository it reaches nobody, so it is not offered.
        setShare(Boolean(r.isRepo));
      });
  }, []);

  const bind = useCallback(() => {
    if (!picked) return;
    setBusy(true);
    setErr(null);
    void bridge()
      ?.project?.bind?.({ dir: picked.dir, write: share, workspace: workspaceName })
      .then((r) => {
        if (!r?.ok) {
          setErr(r?.error ?? "Could not use that folder.");
          return;
        }
        if (r.error) setErr(`Folder saved, but the pointer file could not be written: ${r.error}`);
        else onDone();
      })
      .finally(() => setBusy(false));
  }, [picked, share, workspaceName, onDone]);

  // The folder already names a different workspace. That is a claim by
  // whoever wrote the file, not an instruction — it is shown, and a person
  // decides. Nothing is connected and no credential goes anywhere either way.
  const conflict =
    picked?.config && picked.config.server.replace(/\/+$/, "") !== server.replace(/\/+$/, "")
      ? picked.config
      : null;

  return (
    <div className="setup">
      <div className="setup-card">
        <h2 className="setup-title">Where does {workspaceName}&apos;s code live?</h2>
        <p className="setup-sub">
          The terminal opens here and your agent reads and writes here. Choosing it also writes{" "}
          <code>.mcp.json</code>, which is how your agent reaches this workspace at all — without
          it the agent starts in the right folder with no workspace tools. Remembered for this
          workspace, so another one can point somewhere else.
        </p>

        {!picked ? (
          <div className="row">
            <button className="send" onClick={pick}>
              Choose a folder…
            </button>
            <button
              className="voice-ctl"
              onClick={() => {
                rememberSkip(server);
                onDone();
              }}
            >
              Not now
            </button>
          </div>
        ) : (
          <>
            <div className="row">
              <code className="server-inline">{picked.dir}</code>
              <button className="voice-ctl" onClick={pick}>
                Change
              </button>
            </div>

            {conflict && (
              <div className="setup-warn">
                <strong>This folder already names another workspace.</strong>
                <div>
                  Its <code>bulletz.json</code> points at <code>{host(conflict.server)}</code>
                  {conflict.workspace ? ` (${conflict.workspace})` : ""}. Using it here will
                  {share ? " overwrite that pointer." : " leave that file alone."}
                </div>
                <div className="row">
                  <button
                    className="voice-ctl"
                    onClick={() => {
                      // The point of the file: a clone can hand you the team
                      // it belongs to. It gets you as far as the sign-in
                      // screen for that server and no further — the file is a
                      // claim, so no credential follows from it, and the
                      // normal sign-in is what grants anything.
                      beginAddWorkspace();
                      setServer(conflict.server);
                      location.reload();
                    }}
                  >
                    Sign in to {conflict.workspace ?? host(conflict.server)} instead
                  </button>
                </div>
              </div>
            )}

            {picked.isRepo ? (
              <label className="setup-check">
                <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
                <span>
                  Add <code>bulletz.json</code> here, so a teammate who clones this gets the same
                  workspace. It records the server address only — never a credential.
                </span>
              </label>
            ) : (
              <p className="muted">
                Not a git repository, so there is nobody to share a pointer with. The folder is
                remembered on this machine.
              </p>
            )}

            {err && <div className="members-err">{err}</div>}

            <div className="row">
              <button className="send" disabled={busy} onClick={bind}>
                {busy ? "…" : "Use this folder"}
              </button>
              <button
                className="voice-ctl"
                onClick={() => {
                  rememberSkip(server);
                  onDone();
                }}
              >
                Not now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
