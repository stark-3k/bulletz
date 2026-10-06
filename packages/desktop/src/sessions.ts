import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** The bulletz actor who started the run. A transcript belongs to the person
   *  who asked for it, not to whoever next opens the app on this machine. */
  actorId: string | null;
  actorHandle: string | null;
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

  /** Newest first, without transcripts — the list view does not need them.
   *  Scoped to one actor: an untagged record (written before runs carried an
   *  identity) belongs to nobody and is shown to nobody. */
  list(actorId: string | null): Omit<RunRecord, "events">[] {
    return this.records
      .filter((r) => r.actorId !== null && r.actorId === actorId)
      .slice()
      .reverse()
      .map(({ events: _events, ...rest }) => rest);
  }

  get(id: string, actorId: string | null): RunRecord | null {
    const r = this.records.find((x) => x.id === id) ?? null;
    return r && r.actorId !== null && r.actorId === actorId ? r : null;
  }

  /** The most recent claude session id per channel, so a restart resumes the
   *  conversation instead of starting a stranger in the same room. */
  latestSessions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.records) if (r.sessionId) out[r.channelId] = r.sessionId;
    return out;
  }

  /** Transcripts hold command output and file contents, so the file is
   *  owner-only. Node's default 0644 would let any other account on the
   *  machine read them. */
  private secure() {
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort: a filesystem without POSIX modes must not break writes */
    }
  }

  append(record: RunRecord) {
    const trimmed: RunRecord = {
      ...record,
      events: record.events.slice(-MAX_EVENTS),
    };
    this.records.push(trimmed);
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(trimmed)}\n`, { mode: 0o600 });
      this.secure();
      if (this.records.length > this.limit) this.compact();
    } catch {
      /* a failed write must not take the run down with it */
    }
  }

  private compact() {
    this.records = this.records.slice(-this.limit);
    writeFileSync(this.path, this.records.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    this.secure();
  }
}
