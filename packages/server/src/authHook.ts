import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorForToken, bearerFrom } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: import("@bulletz/shared").Actor;
  }
}

/** Fastify hooks are plugin-scoped, so every route plugin must install this
 *  itself — registering a plugin next to an authenticated one inherits nothing. */
export function requireActor(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerFrom(req.headers.authorization);
    if (!token) return reply.code(401).send({ error: "missing bearer token" });
    const actor = await actorForToken(token);
    if (!actor) return reply.code(401).send({ error: "unknown token" });
    req.actor = actor;
  });
}
