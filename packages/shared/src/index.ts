import { z } from "zod";

/** Event kinds. The log is open-ended by design: unknown kinds are stored and
 *  returned, they just get no special projection. */
export const EVENT_KINDS = [
  "message",
  "tool_call",
  "tool_result",
  "decision",
  "constraint",
  "task_created",
  "task_updated",
  "file_edit",
  "ci",
  "note",
  "agent_turn_start",
  "agent_turn_end",
] as const;

export const ActorKind = z.enum(["human", "agent", "integration"]);
export type ActorKind = z.infer<typeof ActorKind>;

export const Refs = z
  .object({
    paths: z.array(z.string()).optional(),
    prs: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    decisions: z.array(z.string()).optional(),
    urls: z.array(z.string()).optional(),
  })
  .passthrough();
export type Refs = z.infer<typeof Refs>;

export const Actor = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  kind: ActorKind,
  handle: z.string(),
  display_name: z.string(),
  owner_actor_id: z.string().uuid().nullable(),
});
export type Actor = z.infer<typeof Actor>;

export const Thread = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  title: z.string(),
  status: z.enum(["open", "closed"]),
  created_at: z.string(),
  last_event_at: z.string(),
});
export type Thread = z.infer<typeof Thread>;

export const Event = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  thread_id: z.string().uuid().nullable(),
  actor_id: z.string().uuid(),
  actor_handle: z.string().optional(),
  actor_kind: ActorKind.optional(),
  kind: z.string(),
  body: z.string().nullable(),
  payload: z.record(z.unknown()),
  refs: Refs,
  labels: z.array(z.string()),
  seq: z.string(),
  created_at: z.string(),
  revision_of: z.string().uuid().nullable().optional(),
  root_id: z.string().uuid().optional(),
  edited: z.boolean().optional(),
});
export type Event = z.infer<typeof Event>;

export const DecisionStatus = z.enum(["proposed", "accepted", "superseded", "reverted"]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const Decision = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  thread_id: z.string().uuid().nullable(),
  statement: z.string(),
  rationale: z.string().nullable(),
  alternatives: z.array(z.unknown()),
  status: DecisionStatus,
  supersedes_id: z.string().uuid().nullable(),
  entities: Refs,
  source_event_ids: z.array(z.string().uuid()),
  confidence: z.number(),
  decided_by: z.string().uuid().nullable(),
  decided_by_handle: z.string().optional(),
  decided_at: z.string(),
});
export type Decision = z.infer<typeof Decision>;

export const Task = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  thread_id: z.string().uuid().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]),
  labels: z.array(z.string()),
  assignee_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof Task>;

/* ------------------------------- requests ------------------------------- */

export const PostEventInput = z.object({
  thread_id: z.string().uuid().optional(),
  thread_title: z.string().min(1).max(200).optional(),
  kind: z.string().default("message"),
  body: z.string().max(100_000).optional(),
  payload: z.record(z.unknown()).default({}),
  refs: Refs.default({}),
  labels: z.array(z.string()).default([]),
});
export type PostEventInput = z.infer<typeof PostEventInput>;

export const CreateDecisionInput = z.object({
  thread_id: z.string().uuid().optional(),
  statement: z.string().min(3).max(2000),
  rationale: z.string().max(10_000).optional(),
  alternatives: z.array(z.string()).default([]),
  status: DecisionStatus.default("accepted"),
  supersedes_id: z.string().uuid().optional(),
  entities: Refs.default({}),
  source_event_ids: z.array(z.string().uuid()).default([]),
  confidence: z.number().min(0).max(1).default(1),
});
export type CreateDecisionInput = z.infer<typeof CreateDecisionInput>;

export const CreateConstraintInput = z.object({
  rule: z.string().min(3).max(2000),
  rationale: z.string().max(10_000).optional(),
  source_event_ids: z.array(z.string().uuid()).default([]),
});

export const CreateTaskInput = z.object({
  thread_id: z.string().uuid().optional(),
  title: z.string().min(3).max(500),
  body: z.string().max(50_000).optional(),
  labels: z.array(z.string()).default([]),
  assignee_handle: z.string().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const SearchInput = z.object({
  query: z.string().min(1).max(500),
  thread_id: z.string().uuid().optional(),
  kinds: z.array(z.string()).optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  include_superseded: z.boolean().default(false),
});
export type SearchInput = z.infer<typeof SearchInput>;

/** A search hit. Every hit carries source_event_ids so the caller can always
 *  drill from a derived unit back to raw log events. */
export const SearchHit = z.object({
  unit: z.enum(["event", "decision", "constraint", "task", "rollup"]),
  id: z.string(),
  score: z.number(),
  title: z.string().nullable(),
  text: z.string(),
  thread_id: z.string().uuid().nullable(),
  actor_handle: z.string().nullable(),
  created_at: z.string(),
  source_event_ids: z.array(z.string()),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const PresenceInput = z.object({
  machine: z.string().max(200).optional(),
  cwd: z.string().max(500).optional(),
  branch: z.string().max(200).optional(),
  dirty_files: z.number().int().min(0).optional(),
  test_status: z.enum(["passing", "failing", "unknown"]).optional(),
  agent_kind: z.string().max(100).optional(),
  online: z.boolean().default(true),
});
export type PresenceInput = z.infer<typeof PresenceInput>;

/* ------------------------------- realtime ------------------------------- */

export type ServerMessage =
  | { type: "hello"; workspace_id: string; actor: Actor }
  | { type: "event"; event: Event }
  | { type: "thread"; thread: Thread }
  | { type: "decision"; decision: Decision }
  | { type: "task"; task: Task }
  | { type: "presence"; actor_handle: string; online: boolean }
  | { type: "error"; message: string };
