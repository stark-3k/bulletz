import type { Decision, Event, Note, SearchHit, Task, Channel } from "@bulletz/shared";
import { maybeOne, one, q } from "./db.js";

const EVENT_COLS = `
  e.id, e.workspace_id, e.channel_id, e.actor_id, a.handle as actor_handle,
  a.kind as actor_kind, e.kind, e.body, e.payload, e.refs, e.labels,
  e.seq::text as seq, e.created_at, e.revision_of, e.reply_to,
  coalesce(r.root_id, e.id) as root_id,
  (e.revision_of is not null) as edited`;

/** Replies hang off a root message. A root's reply count and last reply time
 *  are computed against the ROOT of each reply's revision chain, so editing a
 *  reply does not inflate the count. */
const REPLY_STATS = `
  (select count(*) from events x
    where x.reply_to = coalesce(r.root_id, e.id)
      -- count the HEAD of each reply's revision chain: an edit must not add to
      -- the total, and a tombstoned reply must drop out of it. Counting
      -- originals instead keeps deleted replies in the tally forever.
      and not exists (select 1 from events n where n.revision_of = x.id)
      and x.kind <> 'message_deleted')::int as reply_count,
  (select max(x.created_at) from events x
    where x.reply_to = coalesce(r.root_id, e.id)
      and not exists (select 1 from events n where n.revision_of = x.id)
      and x.kind <> 'message_deleted')::text as last_reply_at`;

/** A revision chain's head is the event nothing points at. Reads resolve to
 *  heads so the UI shows the current text, while every prior version stays in
 *  the log. Ordering follows the ROOT's seq, so an edited message keeps its
 *  place in the conversation instead of jumping to the end. */
const HEAD_ONLY = `not exists (select 1 from events n where n.revision_of = e.id)`;

const ROOT_CTE = `
  with recursive chain as (
    select id, revision_of, id as root_id, seq as root_seq from events where revision_of is null
    union all
    select e.id, e.revision_of, c.root_id, c.root_seq
      from events e join chain c on e.revision_of = c.id
  )
  select id as rid, root_id, root_seq from chain`;

/* -------------------------------- channels -------------------------------- */

export async function listChannels(
  workspaceId: string,
  opts: { includeArchived?: boolean; limit?: number } = {},
): Promise<Channel[]> {
  return q<Channel>(
    `select id, workspace_id, title, status, created_at, last_event_at
       from channels
      where workspace_id = $1
        and ($2::boolean or status <> 'archived')
      order by last_event_at desc limit $3`,
    [workspaceId, opts.includeArchived ?? false, opts.limit ?? 50],
  );
}

/** Archive is reversible and non-destructive, so any human member may do it.
 *  Agents may not: workspace-level removal is a human decision, the same rule
 *  that gates tool activation. */
export async function setChannelStatus(
  workspaceId: string,
  channelId: string,
  status: "open" | "archived",
  actorId: string,
): Promise<Channel | null> {
  return maybeOne<Channel>(
    `update channels
        set status = $3,
            archived_at = case when $3 = 'archived' then now() else null end,
            archived_by = case when $3 = 'archived' then $4::uuid else null end
      where workspace_id = $1 and id = $2
      returning id, workspace_id, title, status, created_at, last_event_at`,
    [workspaceId, channelId, status, actorId],
  );
}

export async function createChannel(
  workspaceId: string,
  title: string,
  createdBy: string,
): Promise<Channel> {
  return one<Channel>(
    `insert into channels (workspace_id, title, created_by) values ($1, $2, $3)
      returning id, workspace_id, title, status, created_at, last_event_at`,
    [workspaceId, title, createdBy],
  );
}

export async function getChannel(workspaceId: string, channelId: string): Promise<Channel | null> {
  return maybeOne<Channel>(
    `select id, workspace_id, title, status, created_at, last_event_at
       from channels where workspace_id = $1 and id = $2`,
    [workspaceId, channelId],
  );
}

/* --------------------------------- events --------------------------------- */

export async function appendEvent(input: {
  workspaceId: string;
  channelId: string | null;
  actorId: string;
  kind: string;
  body?: string | null | undefined;
  payload?: Record<string, unknown>;
  refs?: Record<string, unknown>;
  labels?: string[];
  revisionOf?: string | null;
  replyTo?: string | null;
}): Promise<Event> {
  const row = await one<Event>(
    `with ins as (
       insert into events (workspace_id, channel_id, actor_id, kind, body, payload, refs, labels, revision_of, reply_to)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[], $9, $10)
       returning *
     ), roots as (${ROOT_CTE})
     select ${EVENT_COLS}, ${REPLY_STATS} from ins e
       join actors a on a.id = e.actor_id
       left join roots r on r.rid = e.id`,
    [
      input.workspaceId,
      input.channelId,
      input.actorId,
      input.kind,
      input.body ?? null,
      JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.refs ?? {}),
      input.labels ?? [],
      input.revisionOf ?? null,
      input.replyTo ?? null,
    ],
  );
  if (input.channelId) {
    await q(`update channels set last_event_at = now() where id = $1`, [input.channelId]);
  }
  return row;
}

export async function channelEvents(
  workspaceId: string,
  channelId: string,
  opts: { limit?: number; beforeSeq?: string } = {},
): Promise<Event[]> {
  const limit = opts.limit ?? 100;
  const rows = await q<Event>(
    `with roots as (${ROOT_CTE})
     select ${EVENT_COLS}, ${REPLY_STATS}
       from events e
       join actors a on a.id = e.actor_id
       left join roots r on r.rid = e.id
      where e.workspace_id = $1 and e.channel_id = $2
        and ${HEAD_ONLY}
        -- the channel shows top-level messages only; replies live in their
        -- own thread and would otherwise flood the room
        and e.reply_to is null
        and ($3::bigint is null or coalesce(r.root_seq, e.seq) < $3::bigint)
      order by coalesce(r.root_seq, e.seq) desc limit $4`,
    [workspaceId, channelId, opts.beforeSeq ?? null, limit],
  );
  return rows.reverse();
}

/** One reply thread: the root message plus its replies, oldest first. */
export async function threadEvents(
  workspaceId: string,
  rootId: string,
): Promise<{ root: Event | null; replies: Event[] }> {
  const rows = await q<Event>(
    `with roots as (${ROOT_CTE})
     select ${EVENT_COLS}, ${REPLY_STATS}
       from events e
       join actors a on a.id = e.actor_id
       left join roots r on r.rid = e.id
      where e.workspace_id = $1
        and (coalesce(r.root_id, e.id) = $2::uuid or e.reply_to = $2::uuid)
        and ${HEAD_ONLY}
      -- order by the ROOT's seq, so editing a reply keeps its place in the
      -- thread rather than moving it to the end
      order by coalesce(r.root_seq, e.seq)`,
    [workspaceId, rootId],
  );
  const root = rows.find((r) => !r.reply_to) ?? null;
  return { root, replies: rows.filter((r) => r.reply_to) };
}

export async function recentEvents(workspaceId: string, limit = 50): Promise<Event[]> {
  const rows = await q<Event>(
    `with roots as (${ROOT_CTE})
     select ${EVENT_COLS}
       from events e
       join actors a on a.id = e.actor_id
       left join roots r on r.rid = e.id
      where e.workspace_id = $1 and ${HEAD_ONLY}
      order by e.seq desc limit $2`,
    [workspaceId, limit],
  );
  return rows.reverse();
}

/* -------------------------------- decisions ------------------------------- */

const DECISION_COLS = `
  d.id, d.workspace_id, d.channel_id, d.statement, d.rationale, d.alternatives,
  d.status, d.supersedes_id, d.entities, d.source_event_ids, d.confidence,
  d.decided_by, a.handle as decided_by_handle, d.decided_at`;

export async function createDecision(input: {
  workspaceId: string;
  channelId: string | null;
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
       insert into decisions (workspace_id, channel_id, statement, rationale, alternatives,
                              status, supersedes_id, entities, source_event_ids, confidence, decided_by)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::uuid[],$10,$11)
       returning *
     )
     select ${DECISION_COLS} from ins d left join actors a on a.id = d.decided_by`,
    [
      input.workspaceId,
      input.channelId,
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
    channelId?: string | undefined;
    path?: string | undefined;
    limit?: number;
  } = {},
): Promise<Decision[]> {
  return q<Decision>(
    `select ${DECISION_COLS}
       from decisions d left join actors a on a.id = d.decided_by
      where d.workspace_id = $1
        and ($2::boolean or d.status in ('accepted','proposed'))
        and ($3::uuid is null or d.channel_id = $3::uuid)
        and ($4::text is null or d.entities @> jsonb_build_object('paths', jsonb_build_array($4::text)))
      order by d.decided_at desc limit $5`,
    [
      workspaceId,
      opts.includeSuperseded ?? false,
      opts.channelId ?? null,
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
  channelId: string | null;
  title: string;
  body?: string | undefined;
  labels: string[];
  assigneeId: string | null;
  createdBy: string;
}): Promise<Task> {
  return one<Task>(
    `insert into tasks (workspace_id, channel_id, title, body, labels, assignee_id, created_by)
     values ($1,$2,$3,$4,$5::text[],$6,$7)
     returning id, workspace_id, channel_id, title, body, status, labels, assignee_id,
               created_at, updated_at`,
    [
      input.workspaceId,
      input.channelId,
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
    `select id, workspace_id, channel_id, title, body, status, labels, assignee_id,
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
      returning id, workspace_id, channel_id, title, body, status, labels, assignee_id,
                created_at, updated_at`,
    [workspaceId, taskId, patch.status ?? null, patch.title ?? null, patch.body ?? null, patch.labels ?? null],
  );
}

/* ---------------------------------- notes --------------------------------- */

const NOTE_COLS = `
  n.id, n.workspace_id, n.channel_id, n.title, n.body, n.labels, n.pinned, n.status,
  n.created_by, c.handle as created_by_handle,
  n.updated_by, u.handle as updated_by_handle,
  n.created_at, n.updated_at`;

const NOTE_JOINS = `
  from notes n
  left join actors c on c.id = n.created_by
  left join actors u on u.id = n.updated_by`;

export async function createNote(input: {
  workspaceId: string;
  channelId: string | null;
  title: string;
  body: string;
  labels: string[];
  pinned: boolean;
  createdBy: string;
}): Promise<Note> {
  const row = await one<{ id: string }>(
    `insert into notes (workspace_id, channel_id, title, body, labels, pinned,
                        created_by, updated_by)
     values ($1,$2,$3,$4,$5::text[],$6,$7,$7) returning id`,
    [
      input.workspaceId,
      input.channelId,
      input.title,
      input.body,
      input.labels,
      input.pinned,
      input.createdBy,
    ],
  );
  // Re-read through the join so a created note has the same shape as a listed
  // one — the client renders both from the same component.
  return (await getNote(input.workspaceId, row.id)) as Note;
}

export async function getNote(workspaceId: string, id: string): Promise<Note | null> {
  return maybeOne<Note>(
    `select ${NOTE_COLS} ${NOTE_JOINS} where n.workspace_id = $1 and n.id = $2`,
    [workspaceId, id],
  );
}

export async function listNotes(
  workspaceId: string,
  opts: { includeArchived?: boolean; labels?: string[] | undefined; limit?: number } = {},
): Promise<Note[]> {
  return q<Note>(
    `select ${NOTE_COLS} ${NOTE_JOINS}
      where n.workspace_id = $1
        and ($2::boolean or n.status = 'active')
        and ($3::text[] is null or n.labels && $3::text[])
      order by n.pinned desc, n.updated_at desc
      limit $4`,
    [workspaceId, opts.includeArchived ?? false, opts.labels ?? null, opts.limit ?? 200],
  );
}

/** Last write wins, by design — see sql/009_notes.sql. `updated_by` records who
 *  touched it last so a surprising change has a name attached to it. */
export async function updateNote(
  workspaceId: string,
  id: string,
  patch: {
    title?: string | undefined;
    body?: string | undefined;
    labels?: string[] | undefined;
    pinned?: boolean | undefined;
    status?: string | undefined;
  },
  actorId: string,
): Promise<Note | null> {
  const updated = await maybeOne<{ id: string }>(
    `update notes set
       title  = coalesce($3, title),
       -- body is coalesced on an explicit null, so clearing a note to empty
       -- works: the route only passes a value when the key was present.
       body   = coalesce($4, body),
       labels = coalesce($5::text[], labels),
       pinned = coalesce($6::boolean, pinned),
       status = coalesce($7, status),
       updated_by = $8,
       updated_at = now()
      where workspace_id = $1 and id = $2
      returning id`,
    [
      workspaceId,
      id,
      patch.title ?? null,
      patch.body ?? null,
      patch.labels ?? null,
      patch.pinned ?? null,
      patch.status ?? null,
      actorId,
    ],
  );
  if (!updated) return null;
  return getNote(workspaceId, id);
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

/** Returns the head of the chain this event belongs to, with its author — the
 *  only row an edit or delete may target. */
export async function eventHead(workspaceId: string, eventId: string) {
  return maybeOne<{
    id: string;
    actor_id: string;
    kind: string;
    channel_id: string | null;
    body: string | null;
    reply_to: string | null;
  }>(
    `with recursive chain as (
       select id, revision_of, actor_id, kind, channel_id, body, reply_to, workspace_id from events
        where id = $2 and workspace_id = $1
       union all
       select e.id, e.revision_of, e.actor_id, e.kind, e.channel_id, e.body, e.reply_to, e.workspace_id
         from events e join chain c on e.revision_of = c.id
     )
     select id, actor_id, kind, channel_id, body, reply_to from chain c
      where not exists (select 1 from events n where n.revision_of = c.id)
      limit 1`,
    [workspaceId, eventId],
  );
}
