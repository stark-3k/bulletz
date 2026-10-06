import { useState } from "react";
import type { Api } from "./api.ts";

/**
 * Getting started.
 *
 * Deliberately a checklist derived from workspace state rather than a linear
 * wizard with stored flags: a step is done when the thing it asks for exists,
 * so it cannot claim you have a decision log when you do not, and it stays
 * done when a teammate does the work instead of you.
 */

export type OnboardingState = {
  role: string;
  agent: { id: string; handle: string } | null;
  steps: Record<string, { done: boolean; count?: number }>;
};

export function Onboarding({
  api,
  state,
  onRefresh,
  onDismiss,
  onGoTo,
}: {
  api: Api;
  state: OnboardingState;
  onRefresh: () => void;
  onDismiss: () => void;
  onGoTo: (where: "chat" | "members") => void;
}) {
  const [summary, setSummary] = useState("");
  const [link, setLink] = useState({ kind: "repo", label: "", url: "" });
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
      onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const done = Object.values(state.steps).filter((s) => s.done).length;
  const total = Object.keys(state.steps).length;

  const mcpConfig = agentToken
    ? JSON.stringify(
        {
          mcpServers: {
            bulletz: {
              command: "node",
              args: ["packages/mcp/dist/index.js"],
              env: { BULLETZ_SERVER_URL: api.baseUrl, BULLETZ_TOKEN: agentToken },
            },
          },
        },
        null,
        2,
      )
    : null;

  return (
    <div className="onboard">
      <div className="onboard-head">
        <div>
          <div className="onboard-title">Get the workspace useful</div>
          <div className="onboard-sub">
            {done} of {total} done — an agent is only as good as what this holds.
          </div>
        </div>
        <button className="voice-ctl" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      {err && <div className="members-err">{err}</div>}

      <Step
        done={state.steps["describe"]?.done ?? false}
        title="Say what this project is"
        why="The first thing a new agent or teammate reads. The repo cannot tell them."
      >
        <textarea
          rows={2}
          value={summary}
          placeholder="One or two sentences: what this is, and what it is for."
          onChange={(e) => setSummary(e.target.value)}
        />
        <button
          className="send"
          disabled={busy || summary.trim().length < 10}
          onClick={() => void run(() => api.setProjectSummary(summary.trim()))}
        >
          Save
        </button>
      </Step>

      <Step
        done={state.steps["links"]?.done ?? false}
        count={state.steps["links"]?.count}
        title="Record where it lives"
        why="The production URL, the repo, the dashboards — none of it is in the checkout."
      >
        <select value={link.kind} onChange={(e) => setLink({ ...link, kind: e.target.value })}>
          {["repo", "site", "staging", "docs", "dashboard", "tracker"].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          value={link.label}
          placeholder="label"
          onChange={(e) => setLink({ ...link, label: e.target.value })}
        />
        <input
          value={link.url}
          placeholder="https://…"
          onChange={(e) => setLink({ ...link, url: e.target.value })}
        />
        <button
          className="send"
          disabled={busy || !link.label.trim() || !/^https?:\/\//.test(link.url)}
          onClick={() =>
            void run(async () => {
              await api.addProjectLink({ kind: link.kind, label: link.label.trim(), url: link.url.trim() });
              setLink({ kind: "repo", label: "", url: "" });
            })
          }
        >
          Add
        </button>
      </Step>

      <Step
        done={state.steps["connect"]?.done ?? false}
        title="Connect your coding agent"
        why="This is the point: your agent reads the workspace instead of guessing."
      >
        {!agentToken ? (
          <button
            className="send"
            disabled={busy || !state.agent}
            onClick={() =>
              void run(async () => {
                const r = await api.createAgentToken();
                setAgentToken(r.token);
              })
            }
          >
            {state.agent ? `Create a token for ${state.agent.handle}` : "No agent identity"}
          </button>
        ) : (
          <div className="onboard-config">
            <div className="onboard-note">
              Save as <code>.mcp.json</code> in your project. Shown once — it is stored hashed.
            </div>
            <pre>{mcpConfig}</pre>
            <button
              className="voice-ctl"
              onClick={() => void navigator.clipboard?.writeText(mcpConfig ?? "")}
            >
              Copy config
            </button>
          </div>
        )}
      </Step>

      <Step
        done={state.steps["decide"]?.done ?? false}
        count={state.steps["decide"]?.count}
        title="Record one real decision"
        why="The cheapest test of the whole idea: does an agent that knows this do better?"
      >
        <div className="onboard-note">
          In any channel, type <code>/decide</code> what you chose <code>--</code> why.
        </div>
        <button className="voice-ctl" onClick={() => onGoTo("chat")}>
          Go to a channel
        </button>
      </Step>

      <Step
        done={state.steps["invite"]?.done ?? false}
        count={state.steps["invite"]?.count}
        title="Invite your team"
        why="Shared memory with one person in it is just notes."
      >
        <button className="voice-ctl" onClick={() => onGoTo("members")}>
          Open Members
        </button>
      </Step>
    </div>
  );
}

function Step({
  done,
  title,
  why,
  count,
  children,
}: {
  done: boolean;
  title: string;
  why: string;
  count?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!done);
  return (
    <div className={`onboard-step${done ? " done" : ""}`}>
      <button className="onboard-step-head" onClick={() => setOpen((v) => !v)}>
        <span className="onboard-check">{done ? "✓" : "○"}</span>
        <span className="onboard-step-title">
          {title}
          {count ? <span className="onboard-count">{count}</span> : null}
        </span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="onboard-step-body">
          <div className="onboard-why">{why}</div>
          <div className="onboard-controls">{children}</div>
        </div>
      )}
    </div>
  );
}
