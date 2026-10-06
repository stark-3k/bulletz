-- Identity, roles, sessions and invites.
--
-- Until now a workspace token was a password that never expired and could not
-- be revoked: losing a laptop meant rotating everyone. This adds real sign-in
-- for people, short-lived revocable sessions, and long-lived API tokens that
-- are revocable individually — the shape agents and MCP actually need.

-- Roles are coarse on purpose. A small team needs "who can change the shape of
-- the workspace" and "who can only read", not a permission matrix.
alter table actors add column if not exists role text not null default 'member'
  check (role in ('owner', 'admin', 'member', 'guest'));
alter table actors add column if not exists status text not null default 'active'
  check (status in ('active', 'disabled'));
alter table actors add column if not exists email text;
alter table actors add column if not exists password_hash text;
alter table actors add column if not exists created_by uuid references actors(id) on delete set null;
create unique index if not exists actors_ws_email_idx on actors (workspace_id, lower(email))
  where email is not null;

-- A session is what a browser holds. Short-lived, revocable one at a time, and
-- carrying enough context that a person can recognise a device they do not
-- remember signing in from.
create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references actors(id) on delete cascade,
  token_hash   text not null unique,
  user_agent   text,
  ip           text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index if not exists sessions_actor_idx on sessions (actor_id) where revoked_at is null;

-- Long-lived credentials for things that cannot sign in: agents, the MCP
-- bridge, CI. Separate from sessions so revoking a laptop does not break a
-- running agent, and killing a leaked agent token does not sign anyone out.
create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references actors(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  created_by   uuid references actors(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
create index if not exists api_tokens_actor_idx on api_tokens (actor_id) where revoked_at is null;

-- Invites carry the role, so who someone becomes is decided when they are
-- invited rather than after they arrive.
create table if not exists invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  code_hash    text not null unique,
  role         text not null default 'member' check (role in ('admin', 'member', 'guest')),
  note         text,
  created_by   uuid references actors(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_by  uuid references actors(id) on delete set null,
  accepted_at  timestamptz,
  revoked_at   timestamptz
);
create index if not exists invites_ws_idx on invites (workspace_id) where accepted_at is null;

-- The first human in each workspace becomes its owner; everyone else keeps the
-- member default. Without this an existing workspace would have no one able to
-- invite or manage anybody.
update actors a set role = 'owner'
 where a.kind = 'human'
   and a.id = (select id from actors b
                where b.workspace_id = a.workspace_id and b.kind = 'human'
                order by created_at limit 1);
