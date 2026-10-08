#!/bin/sh
# Migrate, then serve.
#
# Migrations run here rather than as a separate deploy step because the only
# thing that must never happen is new code against an old schema, and the
# container is the one place guaranteed to run exactly once per release with
# the right DATABASE_URL already in hand. Every migration is `if not exists`
# or additive, so a repeat is a no-op and a restart loop cannot corrupt
# anything.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set — refusing to start against the built-in default" >&2
  exit 1
fi

echo "running migrations…"
node packages/server/dist/migrate.js

echo "starting bulletz server on ${HOST:-0.0.0.0}:${PORT:-4000}"
exec node packages/server/dist/index.js
