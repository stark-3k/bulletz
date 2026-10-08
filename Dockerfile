# The Bulletz server, with the web UI it serves.
#
# Deliberately excludes @bulletz/desktop. That package depends on node-pty,
# which publishes no Linux prebuilds and would have to be compiled here — a
# C++ toolchain and several minutes, for a native module that only ever runs
# on somebody's laptop. The server never loads it.

# ---------------------------------------------------------------- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first so a dependency install is cached independently of source.
COPY package.json package-lock.json ./
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/server/package.json  packages/server/package.json
COPY packages/web/package.json     packages/web/package.json

# `npm ci` insists the lockfile match the full workspace set, so the desktop
# package is installed and then dropped rather than filtered out here.
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web    packages/web

RUN npm run build -w @bulletz/shared \
 && npm run build -w @bulletz/server \
 # `--mode package` strips VITE_BULLETZ_TOKEN and VITE_BULLETZ_URL. The token
 # must never reach a bundle handed to other people; dropping the pinned URL
 # is what lets the client fall through to location.origin, so a browser
 # pointed at this host talks to this host.
 && npm run build -w @bulletz/web -- --mode package

# Production dependencies only, for the runtime stage.
RUN npm prune --omit=dev --ignore-scripts

# ----------------------------------------------------------------- run -----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# A container that binds loopback is unreachable from the proxy in front of it.
ENV HOST=0.0.0.0
ENV PORT=4000
ENV WEB_ROOT=/app/web
WORKDIR /app

COPY --from=build /app/node_modules                 ./node_modules
COPY --from=build /app/package.json                 ./package.json
COPY --from=build /app/packages/shared/dist         ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/server/dist         ./packages/server/dist
COPY --from=build /app/packages/server/sql          ./packages/server/sql
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/web/dist            ./web

# The workspace symlinks npm created point at package directories that exist
# here, so @bulletz/shared resolves without re-running an install.
COPY --from=build /app/node_modules/@bulletz ./node_modules/@bulletz

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Node's own fetch, so there is nothing extra to install for a health probe.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
