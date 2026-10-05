import cors from "@fastify/cors";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";
import { actorForToken } from "./auth.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { addConn, connectionCount } from "./realtime.js";
import { apiRoutes } from "./routes/api.js";
import { widgetRoutes } from "./routes/widgets.js";

const app = Fastify({ logger: { level: env.logLevel } });

await app.register(cors, { origin: true });

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
    const actor = token ? await actorForToken(token) : null;
    if (!actor) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // hello first: a client must learn who it is before it sees any fanout,
      // and addConn broadcasts this actor's presence immediately.
      ws.send(JSON.stringify({ type: "hello", workspace_id: actor.workspace_id, actor }));
      const remove = addConn({ ws, workspaceId: actor.workspace_id, actorHandle: actor.handle });
      ws.on("close", remove);
      ws.on("error", remove);
    });
  } catch (err) {
    app.log.error({ err }, "ws upgrade failed");
    socket.destroy();
  }
});

await app.listen({ port: env.port, host: "127.0.0.1" });
app.log.info(`bulletz server on http://127.0.0.1:${env.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
