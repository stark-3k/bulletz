-- Threads are archived, never destroyed — the same shape as messages
-- (tombstone), decisions (supersede) and constraints (retire). An archived
-- thread leaves the sidebar, search and context packs, but its events remain
-- in the log, so what an agent read at the time is still reconstructible.
alter table threads drop constraint if exists threads_status_check;
alter table threads add constraint threads_status_check
  check (status in ('open', 'closed', 'archived'));
alter table threads add column if not exists archived_at timestamptz;
alter table threads add column if not exists archived_by uuid references actors(id) on delete set null;
create index if not exists threads_ws_status_idx on threads (workspace_id, status, last_event_at desc);
