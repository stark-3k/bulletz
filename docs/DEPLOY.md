# Deploying a Bulletz server

The server and the web UI ship in one container. Postgres runs alongside it.
Your team then points the desktop app at the hostname, or opens it in a
browser — both reach the same origin, which is why there is no CORS to
configure.

## On Dokploy

1. **Create a Compose application.** In Dokploy: *Create Application →
   Compose*, point it at this repository, and set the compose path to
   `docker-compose.deploy.yml`.

2. **Set two environment variables** in Dokploy's Environment tab:

   ```
   POSTGRES_PASSWORD=<generate one: openssl rand -base64 32>
   ```

   That is the only required one. `CORS_ORIGINS` exists but is for the unusual
   case where a *separately hosted* copy of the web UI must call this API;
   same-origin and the desktop app both work without it.

3. **Add a domain** pointing at the `server` service, port `4000`. Let Dokploy
   issue the certificate. Traefik terminates TLS and proxies through; the
   container binds `0.0.0.0:4000` inside its own network and is not otherwise
   reachable.

4. **Deploy.** The first boot runs migrations and then starts the server. Watch
   the logs for `running migrations…` followed by `bulletz server on
   0.0.0.0:4000`.

5. **Open the domain in a browser.** The first visit offers first-run setup —
   workspace name, your handle, a password. That endpoint closes itself
   permanently once a workspace exists, so the server is never an open door.

6. **Point the desktop app at it.** On first launch it asks for a server
   address; enter the domain. For an install that is already signed in
   somewhere, use *Add a workspace…* in the workspace menu.

## What the compose file does

| | |
|---|---|
| `db` | `pgvector/pgvector:pg17` — the stock Postgres image has no `pgvector`, which the schema needs. No published port: it is reachable from the server container and nothing else. |
| `server` | Built from the `Dockerfile`. Serves the API at `/v1`, the WebSocket at `/v1/stream`, and the web UI at `/`. |
| `bulletz-pgdata` | A named volume. **This is the workspace.** Everything else is replaceable. |

The image deliberately excludes `@bulletz/desktop`: it depends on `node-pty`,
which publishes no Linux prebuilds and would need a C++ toolchain to compile,
for a native module that only ever runs on a laptop.

## Backups

The event log is the system of record and lives in the `bulletz-pgdata`
volume. Nothing else in the deployment holds state worth keeping.

```sh
docker compose -p <project> exec -T db pg_dump -U bulletz bulletz | gzip > bulletz-$(date +%F).sql.gz
```

Restore into an empty database:

```sh
gunzip -c bulletz-2026-01-01.sql.gz | docker compose -p <project> exec -T db psql -U bulletz -d bulletz
```

Dokploy can also snapshot the volume on a schedule; either is fine, but do one
of them before you have anything you would miss.

## Upgrading

Redeploy from Dokploy. The entrypoint runs migrations before the server
starts, so a release that adds a migration applies it on the way up. Every
migration is additive or `if not exists`, so a restart loop cannot corrupt
anything — but take a backup before a release that changes the schema, because
nothing here rolls one back.

## Before you trust it with anything

- **Voice needs a TURN server.** Without one, roughly 10–20% of connections —
  anyone behind symmetric NAT — cannot connect at all. `coturn` with
  `use-auth-secret`, and the `TURN_*` variables in `.env.example`.
- **There is no rate limiting** on `/v1/auth/*`. A public host wants some.
- **Accounts are invite-only by design.** There is no self-registration; an
  admin issues invite codes, and password resets are admin-minted codes handed
  over out of band. If the sole owner is locked out:

  ```sh
  docker compose -p <project> exec server node packages/server/dist/resetPassword.js <handle>
  ```

## Running it without Dokploy

The compose file has no Dokploy-specific anything in it. Anywhere with Docker:

```sh
POSTGRES_PASSWORD=$(openssl rand -base64 32) \
  docker compose -f docker-compose.deploy.yml up -d --build
```

Then put a reverse proxy with TLS in front of the `server` service on port
4000. Do not expose port 4000 directly — the app has no TLS of its own, and
tokens would cross the network in the clear.
