import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { identify } from "./identity.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { addConn, connectionCount } from "./realtime.js";
import * as voice from "./voice.js";
import { apiRoutes } from "./routes/api.js";
import { authRoutes } from "./routes/auth.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { widgetRoutes } from "./routes/widgets.js";

const app = Fastify({ logger: { level: env.logLevel } });

// Same-origin by default. `origin: true` reflects whatever asks, which is
// fine on a laptop and wrong on a public host — any page on the internet could
// then call this API with a victim's cookies. There are none here (auth is a
// bearer token, not a cookie) so the risk is modest, but reflecting everything
// is still not a thing to ship.
//
// A desktop client is not a browser origin: it loads over file:// and sends
// `Origin: null`, or no Origin at all. Those are allowed unconditionally —
// blocking them would break the app without protecting anything, since CORS
// only ever constrains browsers.
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

await app.register(cors, {
  origin(origin, cb) {
    if (!origin || origin === "null") return cb(null, true);
    // A page can only carry a loopback origin if it is being served from this
    // machine, so there is no stranger to protect against — and in
    // development the UI is on :5174 while the API is on :4000, which is
    // cross-origin every single time.
    if (LOOPBACK.test(origin)) return cb(null, true);
    if (env.corsOrigins.length === 0) return cb(null, false);
    cb(null, env.corsOrigins.includes(origin));
  },
});

// A malformed request is the client's fault, not a server crash. Without this
// every validation failure surfaced as a 500, which buries real faults in
// noise and tells the caller nothing about what it got wrong.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({
      error: "invalid request",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const e = err as { statusCode?: number; message?: string };
  const status = e.statusCode ?? 500;
  if (status >= 500) app.log.error({ err }, "unhandled error");
  return reply.code(status).send({ error: e.message || "internal error" });
});

app.get("/health", async () => {
  const { rows } = await pool.query<{ n: number }>("select 1 as n");
  return { ok: rows[0]?.n === 1, connections: connectionCount() };
});

// The built web UI, when this server is also serving it. One origin means no
// CORS to configure, and the client's own resolution falls through to
// location.origin — so a browser pointed at this host just works.
if (env.webRoot) {
  const index = join(env.webRoot, "index.html");
  if (!existsSync(index)) {
    app.log.error({ webRoot: env.webRoot }, "WEB_ROOT is set but has no index.html");
  } else {
    await app.register(fastifyStatic, { root: env.webRoot, wildcard: false });
    // Single-page app: any path that is not a file and not an API route is the
    // app's own routing, so it gets index.html rather than a 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/v1/") || req.url === "/health") {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
    app.log.info({ webRoot: env.webRoot }, "serving the web UI");
  }
}

await app.register(bootstrapRoutes, { prefix: "/v1" });
await app.register(authRoutes, { prefix: "/v1" });
await app.register(apiRoutes, { prefix: "/v1" });
await app.register(widgetRoutes, { prefix: "/v1" });

// Realtime fanout. Token in the query string because browsers cannot set
// headers on a WebSocket handshake.
const wss = new WebSocketServer({ noServer: true });

app.server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/stream") return socket.destroy();

    const token = url.searchParams.get("token");
    const actor = token ? await identify(token) : null;
    if (!actor) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // One peer id per CONNECTION, not per actor: the same person in two
      // windows is two peers and must negotiate separately.
      const peerId = randomUUID();
      ws.send(JSON.stringify({ type: "hello", workspace_id: actor.workspace_id, actor, peer_id: peerId }));
      const remove = addConn({ ws, workspaceId: actor.workspace_id, actorHandle: actor.handle });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return; // a client that sends junk is ignored, not disconnected
        }
        const type = msg["type"];
        if (type === "voice:join" && typeof msg["channel_id"] === "string") {
          voice.join({
            ws,
            workspaceId: actor.workspace_id,
            channelId: msg["channel_id"],
            actorId: actor.id,
            handle: actor.handle,
            peerId,
          });
        } else if (type === "voice:leave") {
          voice.leave(peerId);
        } else if (type === "voice:state") {
          voice.setState(peerId, {
            muted: msg["muted"] as boolean | undefined,
            sharing: msg["sharing"] as boolean | undefined,
          });
        } else if (type === "voice:signal" && typeof msg["to"] === "string") {
          voice.relay(peerId, msg["to"], msg["data"]);
        }
      });

      const cleanup = () => {
        voice.leave(peerId);
        remove();
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    });
  } catch (err) {
    app.log.error({ err }, "ws upgrade failed");
    socket.destroy();
  }
});

await app.listen({ port: env.port, host: env.host });
app.log.info(`bulletz server on http://${env.host}:${env.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
