import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent } from "./agent.js";

/**
 * A local record of agent runs.
 *
 * Deliberately on disk and NOT on the server: a transcript is private to the
 * machine that produced it. Without this, every run's reasoning died with the
 * window and the channel→session mapping died with the app, so a channel's
 * conversation silently restarted from nothing after a restart.
 */
export type RunRecord = {
  id: string;
  channelId: string;
  /** Claude Code's own session id — `claude --resume <this>` reopens it. */
  sessionId: string | null;
  prompt: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "success" | "error" | string;
  costUsd: number | null;
  turns: number | null;
  events: AgentEvent[];
};

const MAX_EVENTS = 400;

export class SessionStore {
  private records: RunRecord[] = [];

  constructor(private path: string, private limit = 200) {
    this.load();
  }

  private load() {
    try {
      if (!existsSync(this.path)) return;
      this.records = readFileSync(this.path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunRecord);
    } catch {
      this.records = []; // a corrupt line should not stop the app booting
    }
  }

  /** Newest first, without transcripts — the list view does not need them. */
  list(): Omit<RunRecord, "events">[] {
    return this.records
      .slice()
      .reverse()
      .map(({ events: _events, ...rest }) => rest);
  }

  get(id: string): RunRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  /** The most recent claude session id per channel, so a restart resumes the
   *  conversation instead of starting a stranger in the same room. */
  latestSessions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.records) if (r.sessionId) out[r.channelId] = r.sessionId;
    return out;
  }

  append(record: RunRecord) {
    const trimmed: RunRecord = {
      ...record,
      events: record.events.slice(-MAX_EVENTS),
    };
    this.records.push(trimmed);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(trimmed)}\n`);
      if (this.records.length > this.limit) this.compact();
    } catch {
      /* a failed write must not take the run down with it */
    }
  }

  private compact() {
    this.records = this.records.slice(-this.limit);
    writeFileSync(this.path, this.records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
}
