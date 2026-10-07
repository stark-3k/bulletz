-- Notifications, and the read state they are counted against.
--
-- Two different questions, deliberately answered by two different tables.
--
-- "What happened that was *addressed to me*" is an inbox: a mention, a reply,
-- a task assigned, an agent finishing. Each is a discrete thing with its own
-- read state, because dismissing one should not dismiss the others.
--
-- "What have I not caught up on" is a cursor, not a list. A busy channel can
-- produce thousands of events nobody needs a row for — storing one unread
-- marker per person per message would make the notifications table larger than
-- the event log it describes. A single high-water mark per channel answers it
-- in one integer, and `events.seq` already provides the ordering.

/* ------------------------------- read state ------------------------------- */

create table if not exists channel_reads (
  actor_id      uuid not null references actors(id) on delete cascade,
  channel_id    uuid not null references channels(id) on delete cascade,
  -- The highest events.seq this person has seen in this channel. Monotonic:
  -- opening older history must never un-read what was already read.
  last_read_seq bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (actor_id, channel_id)
);

/* -------------------------------- the inbox ------------------------------- */

create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  -- Who it is for. Always a human: agents do not read notifications.
  actor_id      uuid not null references actors(id) on delete cascade,
  kind          text not null check (kind in ('mention','reply','task','agent','system')),
  title         text not null,
  body          text,
  -- Where it points. Null for notifications with nowhere to go, like a
  -- system message about the app itself.
  channel_id    uuid references channels(id) on delete cascade,
  event_id      uuid references events(id) on delete cascade,
  -- Who caused it, so the UI can say "rishabh mentioned you" without a join
  -- through the event that may since have been tombstoned.
  from_actor_id uuid references actors(id) on delete set null,
  from_handle   text,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

-- The two queries the inbox actually runs: the unread badge, and the panel.
create index if not exists notifications_unread_idx
  on notifications (actor_id, created_at desc) where read_at is null;
create index if not exists notifications_recent_idx
  on notifications (actor_id, created_at desc);

-- One notification per person per event. A message that mentions someone twice
-- is still one mention, and a retried write must not double it.
create unique index if not exists notifications_once_idx
  on notifications (actor_id, event_id, kind) where event_id is not null;

/* ------------------------------- preferences ------------------------------ */

-- Kept on the actor rather than in its own table: it is a handful of booleans
-- read on every fan-out, and a join per recipient per message is a cost with
-- nothing to show for it. Absent keys mean "on", so an existing account opts
-- into new notification kinds rather than silently missing them.
alter table actors add column if not exists notify_prefs jsonb not null default '{}'::jsonb;

-- Channels someone has explicitly muted. Separate from prefs because it is a
-- set that grows, and because a muted channel should still be re-readable as a
-- list in the UI.
create table if not exists channel_mutes (
  actor_id   uuid not null references actors(id) on delete cascade,
  channel_id uuid not null references channels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (actor_id, channel_id)
);
