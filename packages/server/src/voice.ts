import type { WebSocket } from "ws";

/**
 * Voice room state and signalling relay.
 *
 * The server never touches media. It keeps who is in which room and forwards
 * opaque SDP/ICE between peers — a mesh, where every participant connects
 * directly to every other. That is fine for a handful of people and quadratic
 * beyond it: at roughly five participants this needs an SFU instead, which is
 * a real server component and a separate decision.
 */

export type Participant = {
  actorId: string;
  handle: string;
  /** Stable per-connection id: one person may be in from two windows. */
  peerId: string;
  muted: boolean;
  sharing: boolean;
};

type Member = Participant & { ws: WebSocket; workspaceId: string; channelId: string };

const members = new Map<string, Member>(); // peerId -> member

export type VoiceSignal =
  | { type: "voice:join"; channel_id: string }
  | { type: "voice:leave" }
  | { type: "voice:state"; muted?: boolean; sharing?: boolean }
  | { type: "voice:signal"; to: string; data: unknown };

const send = (ws: WebSocket, msg: unknown) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

export const roster = (channelId: string): Participant[] =>
  [...members.values()]
    .filter((m) => m.channelId === channelId)
    .map(({ ws: _ws, workspaceId: _w, channelId: _c, ...p }) => p);

/** Everyone in a workspace sees room membership, so a channel can show who is
 *  talking without being joined. Only peers in the room get signalling. */
function announce(workspaceId: string, channelId: string) {
  const list = roster(channelId);
  for (const m of members.values()) {
    if (m.workspaceId === workspaceId) {
      send(m.ws, { type: "voice:roster", channel_id: channelId, participants: list });
    }
  }
}

export function join(args: {
  ws: WebSocket;
  workspaceId: string;
  channelId: string;
  actorId: string;
  handle: string;
  peerId: string;
}) {
  // One room at a time per connection.
  leave(args.peerId, false);

  const existing = roster(args.channelId);
  members.set(args.peerId, {
    ws: args.ws,
    workspaceId: args.workspaceId,
    channelId: args.channelId,
    actorId: args.actorId,
    handle: args.handle,
    peerId: args.peerId,
    muted: false,
    sharing: false,
  });

  // The joiner is told who was already here and is responsible for offering to
  // each of them. Making the newcomer always the caller avoids glare, where
  // both sides offer at once and the negotiation collapses.
  send(args.ws, { type: "voice:joined", channel_id: args.channelId, peers: existing });
  announce(args.workspaceId, args.channelId);
}

export function leave(peerId: string, doAnnounce = true) {
  const m = members.get(peerId);
  if (!m) return;
  members.delete(peerId);
  for (const other of members.values()) {
    if (other.channelId === m.channelId) send(other.ws, { type: "voice:peer_left", peer_id: peerId });
  }
  if (doAnnounce) announce(m.workspaceId, m.channelId);
}

export function setState(peerId: string, patch: { muted?: boolean; sharing?: boolean }) {
  const m = members.get(peerId);
  if (!m) return;
  if (patch.muted !== undefined) m.muted = patch.muted;
  if (patch.sharing !== undefined) m.sharing = patch.sharing;
  announce(m.workspaceId, m.channelId);
}

/** Forward an offer/answer/candidate. The payload is opaque to the server. */
export function relay(fromPeerId: string, to: string, data: unknown) {
  const from = members.get(fromPeerId);
  const target = members.get(to);
  // Both ends must be in the same room: a peer id alone must not be enough to
  // push signalling at someone in another channel.
  if (!from || !target || from.channelId !== target.channelId) return;
  send(target.ws, { type: "voice:signal", from: fromPeerId, data });
}

export const channelsWithVoice = (workspaceId: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const m of members.values()) {
    if (m.workspaceId !== workspaceId) continue;
    out[m.channelId] = (out[m.channelId] ?? 0) + 1;
  }
  return out;
};
