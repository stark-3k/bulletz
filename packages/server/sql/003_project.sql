-- Project identity and coordinates.
--
-- Deliberately a separate concept from constraints (rules you must not break)
-- and decisions (choices with a rationale, subject to supersession). "The repo
-- is at github.com/x/y" is neither: it is a stable fact about where the project
-- lives. Filing it as a constraint would dilute the section an agent is told
-- never to violate.
--
-- The bar for what belongs here: it must NOT be derivable from the checkout.
-- The agent already has the files; it does not know the production URL, the
-- staging host, or which dashboard shows the error budget.

alter table workspaces add column if not exists summary text;
alter table workspaces add column if not exists summary_updated_at timestamptz;

create table if not exists project_links (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  kind          text not null check (kind in
                  ('repo','site','staging','docs','dashboard','tracker','design','api','chat','other')),
  label         text not null,
  url           text not null,
  notes         text,
  status        text not null default 'active' check (status in ('active','retired')),
  created_by    uuid references actors(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (workspace_id, label)
);
create index if not exists project_links_ws_idx on project_links (workspace_id, status, kind);
