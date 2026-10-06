import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerFrom } from "./auth.js";
import { can, identify, type Capability, type Identity } from "./identity.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Identity;
  }
}

/** Fastify hooks are plugin-scoped, so every route plugin must install this
 *  itself — registering a plugin next to an authenticated one inherits nothing. */
export function requireActor(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerFrom(req.headers.authorization);
    if (!token) return reply.code(401).send({ error: "missing bearer token" });
    const actor = await identify(token);
    if (!actor) return reply.code(401).send({ error: "invalid or revoked credential" });
    req.actor = actor;
  });
}

/** Guard a single route on a capability. Returns true when the request may
 *  proceed, and has already answered when it may not. */
export function allow(req: FastifyRequest, reply: FastifyReply, capability: Capability): boolean {
  if (can(req.actor, capability)) return true;
  void reply.code(403).send({ error: `your role (${req.actor.role}) cannot ${capability}` });
  return false;
}
