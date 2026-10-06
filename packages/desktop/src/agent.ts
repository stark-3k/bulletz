import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

/**
 * Claude Code adapter.
 *
 * MCP is pull-only: it lets an agent read and write the workspace, but nothing
 * wakes it. This is the other half — a chat message starts a turn.
 *
 * The transcript is PRIVATE: it streams to the operator's window and nowhere
 * else. An agent thinking out loud and calling twelve tools is working, not
 * reporting; mirroring that into a shared channel buries the room. What
 * teammates see is whatever the agent deliberately posts.
 *
 * Everything vendor-specific lives in this file. The rest of the app speaks
 * AgentEvent, so a second adapter (Aider, Cursor, …) is a sibling of this file
 * and touches nothing else.
 */

export type AgentEvent =
  | { type: "start"; sessionId: string; model: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "end"; subtype: string; costUsd: number | null; turns: number | null }
  | { type: "error"; message: string };

export type Policy = {
  /** Chat-triggered runs are off until the machine's owner turns them on:
   *  a teammate's message starting a shell here is remote code execution. */
  enabled: boolean;
  /** "owner" — only messages from this machine's own actor may start a turn. */
  triggerFrom: "owner" | "anyone";
  /** Hard ceiling per turn. Note the CLI checks this AFTER a turn completes,
   *  so treat it as a stop condition, not a pre-flight cap. */
  maxBudgetUsd: number;
  /** Runs triggered by anyone other than the owner drop the code-running tools. */
  restrictOthers: boolean;
  /** Mirror the whole transcript into the channel. Off: the agent works
   *  privately and chooses what to report. */
  postTranscript: boolean;
  /** Explicit grant list. `--permission-prompts none` denies anything that
   *  would otherwise prompt — there is nobody at a headless run to approve —
   *  so a tool not named here simply cannot run. Note this is also the right
   *  security shape: the agent gets the workspace and read-only code access,
   *  and must be granted anything beyond that deliberately. */
  allowedTools: string[];
};

/** What an owner-triggered run may do. This matches what the same person gets
 *  by typing in the terminal — asking an agent to build something and denying
 *  it Write is a trap: with `--permission-prompts none` there is no approval
 *  surface, so the denial is silent until it tries. */
export const DEFAULT_ALLOWED_TOOLS = [
  "mcp__bulletz",
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
];

/** What a run triggered by anyone else may do. Read-only, and paired with
 *  --restricted so the code-running tools are gone entirely. */
export const RESTRICTED_ALLOWED_TOOLS = ["mcp__bulletz", "Read", "Glob", "Grep"];

export const DEFAULT_POLICY: Policy = {
  enabled: false,
  triggerFrom: "owner",
  maxBudgetUsd: 2,
  restrictOthers: true,
  postTranscript: false,
  allowedTools: DEFAULT_ALLOWED_TOOLS,
};

type Run = { proc: ChildProcessWithoutNullStreams; claudeSessionId: string | null };

export class ClaudeCodeAdapter {
  readonly id = "claude-code";
  /** channel id -> claude session id, so a channel is one continuous conversation */
  private sessions = new Map<string, string>();
  private running = new Map<string, Run>();

  constructor(
    private opts: {
      cwd: string;
      env: Record<string, string>;
      mcpConfig: string;
      onEvent: (channelId: string, e: AgentEvent) => void;
    },
  ) {}

  isRunning = (channelId: string) => this.running.has(channelId);

  stop(channelId: string) {
    const run = this.running.get(channelId);
    if (!run) return false;
    run.proc.kill("SIGTERM");
    this.running.delete(channelId);
    return true;
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  async run(channelId: string, prompt: string, policy: Policy, trusted: boolean): Promise<void> {
    if (this.running.has(channelId)) {
      this.opts.onEvent(channelId, { type: "error", message: "a turn is already running in this channel" });
      return;
    }

    const prior = this.sessions.get(channelId);
    const sessionId = prior ?? randomUUID();

    const grants = trusted
      ? (policy.allowedTools ?? DEFAULT_ALLOWED_TOOLS)
      : RESTRICTED_ALLOWED_TOOLS;

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", this.opts.mcpConfig,
      "--strict-mcp-config",
      "--max-budget-usd", String(policy.maxBudgetUsd),
      "--permission-prompts", "none",
      "--allowed-tools", ...grants,
      ...(prior ? ["--resume", prior] : ["--session-id", sessionId]),
      // An untrusted trigger gets no shell and no code execution.
      ...(trusted ? [] : ["--restricted"]),
      "--append-system-prompt",
      [
        "You are connected to a bulletz workspace over MCP. Call context_pack before non-trivial work.",
        // Working out loud is private; reporting is a deliberate act.
      // The split is process vs. result: HOW you worked is private, WHAT you
      // concluded is the reply to a question asked in a public room. Suppress
      // the answer too and the person who asked is left staring at silence.
      "HOW YOU WORK IS PRIVATE; YOUR ANSWER IS NOT. Your reasoning, tool calls and",
      "intermediate steps stream only to the person who started this run — narrate freely,",
      "none of it reaches the team.",
      `But you were asked in channel ${channelId}, so your answer belongs there:`,
      `finish by calling post_message with channel_id "${channelId}" exactly once.`,
      "Write it for someone who did not watch you work — the answer, what changed, what is",
      "left — not a narration of your steps. Use a different channel only if asked to.",
      "For a durable decision also call record_decision, for a rule record_constraint,",
      "for follow-up work create_task.",
      "Skip the post only if there is genuinely nothing to report — you were interrupted, or",
      "the answer is already in the channel.",
        // Stating the grants up front matters: there is no approval surface in
        // this session, so an ungranted tool fails silently when tried. Without
        // this an agent plans an implementation it cannot apply, and only finds
        // out several turns and several dollars in.
        `Tools granted this run: ${grants.join(", ")}. Anything outside that list is denied`,
        "automatically with no way to approve it, so do not plan work that depends on it —",
        trusted
          ? "say what you need and why instead."
          : "this run is read-only: report findings and proposed changes rather than making them.",
      ].join(" "),
      prompt,
    ];

    const proc = spawn("claude", args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.running.set(channelId, { proc, claudeSessionId: null });

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // stdin is an open pipe; with the prompt passed as an argument there is
    // nothing more to send, and leaving it open makes the child wait forever.
    proc.stdin.end();

    createInterface({ input: proc.stdout }).on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // non-JSON noise on stdout is not fatal
      }
      this.handle(channelId, sessionId, m);
    });

    await new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        this.running.delete(channelId);
        if (code !== 0 && code !== null) {
          this.opts.onEvent(channelId, {
            type: "error",
            message: `claude exited ${code}${stderr ? `: ${stderr.slice(0, 400)}` : ""}`,
          });
        }
        resolve();
      });
      proc.on("error", (err) => {
        this.running.delete(channelId);
        this.opts.onEvent(channelId, { type: "error", message: err.message });
        resolve();
      });
    });
  }

  private handle(channelId: string, fallbackSession: string, m: Record<string, unknown>) {
    const type = m["type"] as string | undefined;

    if (type === "system" && m["subtype"] === "init") {
      const sid = (m["session_id"] as string) ?? fallbackSession;
      this.sessions.set(channelId, sid);
      this.opts.onEvent(channelId, {
        type: "start",
        sessionId: sid,
        model: (m["model"] as string) ?? "unknown",
      });
      return;
    }

    if (type === "assistant") {
      const content = ((m["message"] as Record<string, unknown>)?.["content"] ?? []) as Array<
        Record<string, unknown>
      >;
      for (const c of content) {
        if (c["type"] === "text" && typeof c["text"] === "string" && c["text"].trim()) {
          this.opts.onEvent(channelId, { type: "text", text: c["text"] });
        } else if (c["type"] === "tool_use") {
          this.opts.onEvent(channelId, {
            type: "tool",
            name: (c["name"] as string) ?? "tool",
            input: c["input"],
          });
        }
      }
      return;
    }

    if (type === "user") {
      const content = ((m["message"] as Record<string, unknown>)?.["content"] ?? []) as Array<
        Record<string, unknown>
      >;
      for (const c of content) {
        if (c["type"] === "tool_result") {
          this.opts.onEvent(channelId, {
            type: "tool_result",
            name: "tool",
            ok: c["is_error"] !== true,
          });
        }
      }
      return;
    }

    if (type === "result") {
      this.opts.onEvent(channelId, {
        type: "end",
        subtype: (m["subtype"] as string) ?? "success",
        costUsd: (m["total_cost_usd"] as number) ?? null,
        turns: (m["num_turns"] as number) ?? null,
      });
    }
  }
}
