import type { ServerMessage } from "@bulletz/shared";
import type { WebSocket } from "ws";

type Conn = { ws: WebSocket; workspaceId: string; actorHandle: string };

const conns = new Set<Conn>();

export function addConn(conn: Conn) {
  conns.add(conn);
  broadcast(conn.workspaceId, { type: "presence", actor_handle: conn.actorHandle, online: true });
  return () => {
    conns.delete(conn);
    broadcast(conn.workspaceId, {
      type: "presence",
      actor_handle: conn.actorHandle,
      online: [...conns].some((c) => c.actorHandle === conn.actorHandle),
    });
  };
}

export function broadcast(workspaceId: string, msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const c of conns) {
    if (c.workspaceId !== workspaceId) continue;
    if (c.ws.readyState === 1) c.ws.send(data);
  }
}

export const connectionCount = () => conns.size;
