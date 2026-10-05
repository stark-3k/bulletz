import type { Decision, Event, SearchHit, Task, Thread } from "@bulletz/shared";
import { maybeOne, one, q } from "./db.js";

const EVENT_COLS = `
  e.id, e.workspace_id, e.thread_id, e.actor_id, a.handle as actor_handle,
  a.kind as actor_kind, e.kind, e.body, e.payload, e.refs, e.labels,
  e.seq::text as seq, e.created_at`;

/* -------------------------------- threads -------------------------------- */

export async function listThreads(workspaceId: string, limit = 50): Promise<Thread[]> {
  return q<Thread>(
    `select id, workspace_id, title, status, created_at, last_event_at
       from threads where workspace_id = $1
      order by last_event_at desc limit $2`,
    [workspaceId, limit],
  );
}

export async function createThread(
  workspaceId: string,
  title: string,
  createdBy: string,
): Promise<Thread> {
  return one<Thread>(
    `insert into threads (workspace_id, title, created_by) values ($1, $2, $3)
      returning id, workspace_id, title, status, created_at, last_event_at`,
    [workspaceId, title, createdBy],
  );
}

export async function getThread(workspaceId: string, threadId: string): Promise<Thread | null> {
  return maybeOne<Thread>(
    `select id, workspace_id, title, status, created_at, last_event_at
       from threads where workspace_id = $1 and id = $2`,
    [workspaceId, threadId],
  );
}

/* --------------------------------- events --------------------------------- */

export async function appendEvent(input: {
  workspaceId: string;
  threadId: string | null;
  actorId: string;
  kind: string;
  body?: string | undefined;
  payload?: Record<string, unknown>;
  refs?: Record<string, unknown>;
  labels?: string[];
}): Promise<Event> {
  const row = await one<Event>(
    `with ins as (
       insert into events (workspace_id, thread_id, actor_id, kind, body, payload, refs, labels)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[])
       returning *
     )
     select ${EVENT_COLS} from ins e join actors a on a.id = e.actor_id`,
    [
      input.workspaceId,
      input.threadId,
      input.actorId,
      input.kind,
      input.body ?? null,
      JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.refs ?? {}),
      input.labels ?? [],
    ],
  );
  if (input.threadId) {
    await q(`update threads set last_event_at = now() where id = $1`, [input.threadId]);
  }
  return row;
}

export async function threadEvents(
  workspaceId: string,
  threadId: string,
  opts: { limit?: number; beforeSeq?: string } = {},
): Promise<Event[]> {
  const limit = opts.limit ?? 100;
  const rows = await q<Event>(
    `select ${EVENT_COLS}
       from events e join actors a on a.id = e.actor_id
      where e.workspace_id = $1 and e.thread_id = $2
        and ($3::bigint is null or e.seq < $3::bigint)
      order by e.seq desc limit $4`,
    [workspaceId, threadId, opts.beforeSeq ?? null, limit],
  );
  return rows.reverse();
}

export async function recentEvents(workspaceId: string, limit = 50): Promise<Event[]> {
  const rows = await q<Event>(
    `select ${EVENT_COLS}
       from events e join actors a on a.id = e.actor_id
      where e.workspace_id = $1 order by e.seq desc limit $2`,
    [workspaceId, limit],
  );
  return rows.reverse();
}

/* -------------------------------- decisions ------------------------------- */

const DECISION_COLS = `
  d.id, d.workspace_id, d.thread_id, d.statement, d.rationale, d.alternatives,
  d.status, d.supersedes_id, d.entities, d.source_event_ids, d.confidence,
  d.decided_by, a.handle as decided_by_handle, d.decided_at`;

export async function createDecision(input: {
  workspaceId: string;
  threadId: string | null;
  statement: string;
  rationale?: string | undefined;
  alternatives: string[];
  status: string;
  supersedesId?: string | undefined;
  entities: Record<string, unknown>;
  sourceEventIds: string[];
  confidence: number;
  decidedBy: string;
}): Promise<Decision> {
  const row = await one<Decision>(
    `with ins as (
       insert into decisions (workspace_id, thread_id, statement, rationale, alternatives,
                              status, supersedes_id, entities, source_event_ids, confidence, decided_by)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::uuid[],$10,$11)
       returning *
     )
     select ${DECISION_COLS} from ins d left join actors a on a.id = d.decided_by`,
    [
      input.workspaceId,
      input.threadId,
      input.statement,
      input.rationale ?? null,
      JSON.stringify(input.alternatives),
      input.status,
      input.supersedesId ?? null,
      JSON.stringify(input.entities),
      input.sourceEventIds,
      input.confidence,
      input.decidedBy,
    ],
  );
  // Superseding is the whole point of the decision log: mark the old one so
  // retrieval stops returning it as current.
  if (input.supersedesId) {
    await q(
      `update decisions set status = 'superseded'
         where id = $1 and workspace_id = $2 and status <> 'superseded'`,
      [input.supersedesId, input.workspaceId],
    );
  }
  return row;
}

export async function listDecisions(
  workspaceId: string,
  opts: {
    includeSuperseded?: boolean;
    threadId?: string | undefined;
    path?: string | undefined;
    limit?: number;
  } = {},
): Promise<Decision[]> {
  return q<Decision>(
    `select ${DECISION_COLS}
       from decisions d left join actors a on a.id = d.decided_by
      where d.workspace_id = $1
        and ($2::boolean or d.status in ('accepted','proposed'))
        and ($3::uuid is null or d.thread_id = $3::uuid)
        and ($4::text is null or d.entities @> jsonb_build_object('paths', jsonb_build_array($4::text)))
      order by d.decided_at desc limit $5`,
    [
      workspaceId,
      opts.includeSuperseded ?? false,
      opts.threadId ?? null,
      opts.path ?? null,
      opts.limit ?? 50,
    ],
  );
}

/* ------------------------------- constraints ------------------------------ */

export async function createConstraint(input: {
  workspaceId: string;
  rule: string;
  rationale?: string | undefined;
  sourceEventIds: string[];
  createdBy: string;
}) {
  return one(
    `insert into project_constraints (workspace_id, rule, rationale, source_event_ids, created_by)
     values ($1,$2,$3,$4::uuid[],$5)
     returning id, workspace_id, rule, rationale, status, source_event_ids, created_at`,
    [input.workspaceId, input.rule, input.rationale ?? null, input.sourceEventIds, input.createdBy],
  );
}

export async function listConstraints(workspaceId: string, limit = 100) {
  return q(
    `select id, workspace_id, rule, rationale, status, source_event_ids, created_at
       from project_constraints
      where workspace_id = $1 and status = 'active'
      order by created_at desc limit $2`,
    [workspaceId, limit],
  );
}

/* ---------------------------------- tasks --------------------------------- */

export async function createTask(input: {
  workspaceId: string;
  threadId: string | null;
  title: string;
  body?: string | undefined;
  labels: string[];
  assigneeId: string | null;
  createdBy: string;
}): Promise<Task> {
  return one<Task>(
    `insert into tasks (workspace_id, thread_id, title, body, labels, assignee_id, created_by)
     values ($1,$2,$3,$4,$5::text[],$6,$7)
     returning id, workspace_id, thread_id, title, body, status, labels, assignee_id,
               created_at, updated_at`,
    [
      input.workspaceId,
      input.threadId,
      input.title,
      input.body ?? null,
      input.labels,
      input.assigneeId,
      input.createdBy,
    ],
  );
}

export async function listTasks(
  workspaceId: string,
  opts: { status?: string[] | undefined; labels?: string[] | undefined; limit?: number } = {},
): Promise<Task[]> {
  return q<Task>(
    `select id, workspace_id, thread_id, title, body, status, labels, assignee_id,
            created_at, updated_at
       from tasks
      where workspace_id = $1
        and ($2::text[] is null or status = any($2::text[]))
        and ($3::text[] is null or labels && $3::text[])
      order by updated_at desc limit $4`,
    [workspaceId, opts.status ?? null, opts.labels ?? null, opts.limit ?? 100],
  );
}

export async function updateTask(
  workspaceId: string,
  taskId: string,
  patch: { status?: string; title?: string; body?: string; labels?: string[] },
): Promise<Task | null> {
  return maybeOne<Task>(
    `update tasks set
       status  = coalesce($3, status),
       title   = coalesce($4, title),
       body    = coalesce($5, body),
       labels  = coalesce($6::text[], labels),
       updated_at = now()
      where workspace_id = $1 and id = $2
      returning id, workspace_id, thread_id, title, body, status, labels, assignee_id,
                created_at, updated_at`,
    [workspaceId, taskId, patch.status ?? null, patch.title ?? null, patch.body ?? null, patch.labels ?? null],
  );
}

/** Constraints are retired, never deleted: they sit in the "do not violate"
 *  section of every context pack, so a wrong one has to be revocable — but the
 *  log still records that it was once in force. */
export async function retireConstraint(workspaceId: string, id: string) {
  return maybeOne<{ id: string; rule: string; status: string }>(
    `update project_constraints set status = 'retired'
      where workspace_id = $1 and id = $2 and status = 'active'
      returning id, rule, status`,
    [workspaceId, id],
  );
}

/* -------------------------------- project -------------------------------- */

export type ProjectLink = {
  id: string;
  kind: string;
  label: string;
  url: string;
  notes: string | null;
  status: string;
};

export async function getProject(workspaceId: string) {
  const ws = await one<{ id: string; slug: string; name: string; summary: string | null }>(
    `select id, slug, name, summary from workspaces where id = $1`,
    [workspaceId],
  );
  const links = await q<ProjectLink>(
    `select id, kind, label, url, notes, status from project_links
      where workspace_id = $1 and status = 'active'
      order by array_position(
        array['repo','site','staging','api','docs','dashboard','tracker','design','chat','other'], kind),
        label`,
    [workspaceId],
  );
  return { ...ws, links };
}

export async function setProjectSummary(workspaceId: string, summary: string) {
  return one(
    `update workspaces set summary = $2, summary_updated_at = now() where id = $1
     returning id, slug, name, summary`,
    [workspaceId, summary],
  );
}

export async function upsertProjectLink(input: {
  workspaceId: string;
  kind: string;
  label: string;
  url: string;
  notes?: string | undefined;
  createdBy: string;
}): Promise<ProjectLink> {
  return one<ProjectLink>(
    `insert into project_links (workspace_id, kind, label, url, notes, created_by)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (workspace_id, label) do update
       set kind = excluded.kind, url = excluded.url, notes = excluded.notes, status = 'active'
     returning id, kind, label, url, notes, status`,
    [input.workspaceId, input.kind, input.label, input.url, input.notes ?? null, input.createdBy],
  );
}

export async function retireProjectLink(workspaceId: string, label: string) {
  return maybeOne(
    `update project_links set status = 'retired'
      where workspace_id = $1 and label = $2 returning id, label, status`,
    [workspaceId, label],
  );
}
