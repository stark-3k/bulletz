-- Tools and widgets. Tools execute on the SERVER: credentials never reach a
-- laptop or an agent's context, and every invocation lands in the shared log.

create table if not exists tools (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  description   text not null,
  input_schema  jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  impl          jsonb not null,            -- {kind:'sql'|'http', ...}
  egress_allow  text[] not null default '{}',
  -- An agent that can both author AND activate a tool is a privilege-escalation
  -- path: untrusted text in a PR body becomes "create a tool that exfiltrates,
  -- then call it". Agents draft; only a human activates.
  status        text not null default 'draft'
                  check (status in ('draft','active','disabled')),
  created_by    uuid references actors(id) on delete set null,
  created_at    timestamptz not null default now(),
  activated_by  uuid references actors(id) on delete set null,
  activated_at  timestamptz,
  unique (workspace_id, name)
);
create index if not exists tools_ws_status_idx on tools (workspace_id, status);

create table if not exists widgets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  description   text,
  kind          text not null check (kind in ('view','html')),
  tool_id       uuid references tools(id) on delete set null,
  tool_args     jsonb not null default '{}'::jsonb,
  view          jsonb,     -- {type, title, mapping..., refresh_ms}
  html          text,      -- kind='html': rendered in a null-origin sandbox
  status        text not null default 'draft'
                  check (status in ('draft','active','disabled')),
  pinned        boolean not null default false,
  created_by    uuid references actors(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists widgets_ws_idx on widgets (workspace_id, status);

-- Server-held secrets for http tools. Substituted at call time; never returned
-- by any read endpoint and never visible to the model.
create table if not exists tool_secrets (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  value         text not null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, name)
);
