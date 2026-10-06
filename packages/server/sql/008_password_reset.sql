-- Password reset without email infrastructure.
--
-- This is a self-hosted tool with no SMTP, so a reset is not a link in an
-- inbox: an admin mints a one-time code and hands it over out of band, the
-- same shape as an invite. The code is stored hashed, expires, and is good
-- for exactly one use.
--
-- The sole-owner case cannot be solved this way — there is nobody above them
-- to mint the code — so `npm run reset-password` on the server box covers it.

create table if not exists password_resets (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references actors(id) on delete cascade,
  code_hash   text not null unique,
  created_by  uuid references actors(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz
);

create index if not exists password_resets_actor_idx
  on password_resets (actor_id) where used_at is null and revoked_at is null;
