-- Notes: the workspace's long-form scratch surface.
--
-- Decisions, constraints and tasks are all deliberately narrow — one statement,
-- one rule, one piece of work. There was nowhere to put the prose that does not
-- fit those shapes: a runbook, an investigation, a paste of env setup, the
-- half-formed shape of a design before it becomes a decision.
--
-- A note is a mutable document, not a log entry. That is the one place in this
-- schema where last-write-wins is the right model: the current text of a
-- runbook is the only version anyone wants, and keeping a revision chain the
-- way `events` does would make every autosave a row. Creation and archiving
-- still append to the log, so the fact that a note exists is in the history
-- even though its edits are not.
--
-- `search` is generated here rather than added later because search.ts already
-- unions over these tsvectors — notes are the unit most worth finding by text,
-- and omitting the column would mean a table rewrite to add it.

create table if not exists notes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  -- Optional provenance: the conversation a note came out of. `set null` so
  -- archiving or deleting a channel never takes the note with it.
  channel_id    uuid references channels(id) on delete set null,
  title         text not null default '',
  body          text not null default '',
  labels        text[] not null default '{}',
  pinned        boolean not null default false,
  -- Archived, not deleted — same reasoning as channels and constraints. A note
  -- someone wrote is evidence of what they were thinking at the time.
  status        text not null default 'active' check (status in ('active','archived')),
  created_by    uuid references actors(id) on delete set null,
  updated_by    uuid references actors(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  search        tsvector generated always as (
                  to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
                ) stored
);

-- The list query is always (workspace, status) ordered pinned-then-recent.
create index if not exists notes_ws_recent_idx
  on notes (workspace_id, status, pinned desc, updated_at desc);
create index if not exists notes_labels_idx on notes using gin (labels);
create index if not exists notes_search_idx on notes using gin (search);
