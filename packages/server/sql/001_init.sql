-- bulletz: the log is the system of record. Everything else is a projection.
create extension if not exists "pgcrypto";
create extension if not exists "vector";

create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Humans, agents and integrations are all actors. An agent is never a human:
-- it acts *for* one (owner_actor_id) but posts under its own identity.
create table if not exists actors (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  kind            text not null check (kind in ('human','agent','integration')),
  handle          text not null,
  display_name    text not null,
  owner_actor_id  uuid references actors(id) on delete set null,
  token_hash      text,
  created_at      timestamptz not null default now(),
  unique (workspace_id, handle)
);
create index if not exists actors_ws_idx on actors (workspace_id);

create table if not exists threads (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  title          text not null,
  status         text not null default 'open' check (status in ('open','closed')),
  created_by     uuid references actors(id) on delete set null,
  created_at     timestamptz not null default now(),
  last_event_at  timestamptz not null default now()
);
create index if not exists threads_ws_recent_idx on threads (workspace_id, last_event_at desc);

-- THE LOG. Append-only. Never updated, never deleted in normal operation.
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  thread_id     uuid references threads(id) on delete cascade,
  actor_id      uuid not null references actors(id) on delete restrict,
  kind          text not null,
  body          text,
  payload       jsonb not null default '{}'::jsonb,
  refs          jsonb not null default '{}'::jsonb,
  labels        text[] not null default '{}',
  seq           bigserial not null,
  created_at    timestamptz not null default now(),
  search        tsvector generated always as (to_tsvector('english', coalesce(body, ''))) stored
);
create index if not exists events_ws_seq_idx     on events (workspace_id, seq desc);
create index if not exists events_thread_seq_idx on events (thread_id, seq);
create index if not exists events_search_idx     on events using gin (search);
create index if not exists events_labels_idx     on events using gin (labels);
create index if not exists events_refs_idx       on events using gin (refs jsonb_path_ops);
create index if not exists events_kind_idx       on events (workspace_id, kind, created_at desc);

-- Supersession is load-bearing: retrieval defaults to status='accepted' so an
-- agent never sees March's decision and September's reversal with equal weight.
create table if not exists decisions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  thread_id         uuid references threads(id) on delete set null,
  statement         text not null,
  rationale         text,
  alternatives      jsonb not null default '[]'::jsonb,
  status            text not null default 'accepted'
                      check (status in ('proposed','accepted','superseded','reverted')),
  supersedes_id     uuid references decisions(id) on delete set null,
  entities          jsonb not null default '{}'::jsonb,
  source_event_ids  uuid[] not null default '{}',
  confidence        real not null default 1.0,
  decided_by        uuid references actors(id) on delete set null,
  decided_at        timestamptz not null default now(),
  search            tsvector generated always as (
                      to_tsvector('english', coalesce(statement,'') || ' ' || coalesce(rationale,''))
                    ) stored
);
create index if not exists decisions_ws_status_idx on decisions (workspace_id, status, decided_at desc);
create index if not exists decisions_search_idx    on decisions using gin (search);
create index if not exists decisions_entities_idx  on decisions using gin (entities jsonb_path_ops);
create index if not exists decisions_supersedes_idx on decisions (supersedes_id);

-- Durable rules, as opposed to point-in-time decisions.
create table if not exists project_constraints (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  rule              text not null,
  rationale         text,
  status            text not null default 'active' check (status in ('active','retired')),
  source_event_ids  uuid[] not null default '{}',
  created_by        uuid references actors(id) on delete set null,
  created_at        timestamptz not null default now(),
  search            tsvector generated always as (
                      to_tsvector('english', coalesce(rule,'') || ' ' || coalesce(rationale,''))
                    ) stored
);
create index if not exists constraints_ws_idx    on project_constraints (workspace_id, status);
create index if not exists constraints_search_idx on project_constraints using gin (search);

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  thread_id     uuid references threads(id) on delete set null,
  title         text not null,
  body          text,
  status        text not null default 'open' check (status in ('open','in_progress','blocked','done','cancelled')),
  labels        text[] not null default '{}',
  assignee_id   uuid references actors(id) on delete set null,
  created_by    uuid references actors(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  search        tsvector generated always as (
                  to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
                ) stored
);
create index if not exists tasks_ws_status_idx on tasks (workspace_id, status, updated_at desc);
create index if not exists tasks_labels_idx    on tasks using gin (labels);
create index if not exists tasks_search_idx    on tasks using gin (search);

-- Rollups are a CACHE over the log, never truth. source_from/to let an agent
-- drill back to raw events, and let us invalidate when the range changes.
create table if not exists rollups (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  scope         text not null check (scope in ('episode','thread','workspace')),
  thread_id     uuid references threads(id) on delete cascade,
  level         int not null,
  summary       text not null,
  source_from   bigint not null,
  source_to     bigint not null,
  source_hash   text not null,
  model_id      text,
  created_at    timestamptz not null default now(),
  unique (workspace_id, scope, thread_id, level, source_hash)
);
create index if not exists rollups_lookup_idx on rollups (workspace_id, scope, thread_id, level, source_to desc);

-- Local machine presence: explicitly allowlisted status only. Never file contents.
create table if not exists agent_presence (
  actor_id      uuid primary key references actors(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  machine       text,
  cwd           text,
  branch        text,
  dirty_files   int,
  test_status   text,
  agent_kind    text,
  online        boolean not null default false,
  updated_at    timestamptz not null default now()
);
