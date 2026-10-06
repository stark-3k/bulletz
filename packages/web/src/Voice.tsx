import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice and screen share, as a full mesh.
 *
 * Every participant holds a direct connection to every other one; the server
 * only forwards SDP and ICE. That is the right shape for a handful of people
 * and the wrong one past about five, where connection count grows with the
 * square and an SFU becomes the answer.
 *
 * Negotiation follows the "perfect negotiation" pattern: each side knows
 * whether it is polite, so a glare collision (both offering at once, which
 * happens the moment someone starts sharing mid-call) resolves without either
 * side getting stuck in have-local-offer.
 */

export type VoicePeer = {
  actorId: string;
  handle: string;
  peerId: string;
  muted: boolean;
  sharing: boolean;
};

export type VoiceState = {
  channelId: string | null;
  peers: VoicePeer[];
  streams: Record<string, MediaStream>;
  muted: boolean;
  sharing: boolean;
  error: string | null;
};

const ICE: RTCConfiguration = {
  // Public STUN handles most networks. The ~10-20% behind symmetric NAT need a
  // TURN relay, which is infrastructure someone has to pay for — without it
  // those calls will simply fail to connect.
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

type Conn = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
};

export function useVoice(socket: WebSocket | null, myPeerId: string | null) {
  const [state, setState] = useState<VoiceState>({
    channelId: null,
    peers: [],
    streams: {},
    muted: false,
    sharing: false,
    error: null,
  });

  const conns = useRef(new Map<string, Conn>());
  const localAudio = useRef<MediaStream | null>(null);
  const localScreen = useRef<MediaStream | null>(null);
  const joinedRef = useRef<string | null>(null);

  const signal = useCallback(
    (to: string, data: unknown) => {
      socket?.send(JSON.stringify({ type: "voice:signal", to, data }));
    },
    [socket],
  );

  const makeConn = useCallback(
    (peerId: string, polite: boolean) => {
      const existing = conns.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection(ICE);
      const conn: Conn = { pc, polite, makingOffer: false, ignoreOffer: false };
      conns.current.set(peerId, conn);

      for (const track of localAudio.current?.getTracks() ?? []) {
        pc.addTrack(track, localAudio.current!);
      }
      for (const track of localScreen.current?.getTracks() ?? []) {
        pc.addTrack(track, localScreen.current!);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) signal(peerId, { candidate: e.candidate });
      };
      pc.ontrack = (e) => {
        const [stream] = e.streams;
        if (!stream) return;
        setState((s) => ({ ...s, streams: { ...s.streams, [peerId]: stream } }));
      };
      pc.onnegotiationneeded = async () => {
        try {
          conn.makingOffer = true;
          await pc.setLocalDescription();
          signal(peerId, { description: pc.localDescription });
        } catch {
          /* a failed offer is retried by the next negotiationneeded */
        } finally {
          conn.makingOffer = false;
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          // Usually symmetric NAT with no TURN. Say so rather than hanging.
          setState((s) => ({ ...s, error: `connection to a peer failed (no TURN relay configured)` }));
        }
      };
      return conn;
    },
    [signal],
  );

  const closePeer = useCallback((peerId: string) => {
    conns.current.get(peerId)?.pc.close();
    conns.current.delete(peerId);
    setState((s) => {
      const streams = { ...s.streams };
      delete streams[peerId];
      return { ...s, streams };
    });
  }, []);

  const teardown = useCallback(() => {
    for (const id of [...conns.current.keys()]) closePeer(id);
    localAudio.current?.getTracks().forEach((t) => t.stop());
    localScreen.current?.getTracks().forEach((t) => t.stop());
    localAudio.current = null;
    localScreen.current = null;
    joinedRef.current = null;
    setState({ channelId: null, peers: [], streams: {}, muted: false, sharing: false, error: null });
  }, [closePeer]);

  /* ----------------------------- signalling ----------------------------- */

  useEffect(() => {
    if (!socket) return;
    const onMessage = async (e: MessageEvent) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(e.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = m["type"] as string | undefined;

      if (type === "voice:joined") {
        // We are the newcomer, so we offer to everyone already here. Being the
        // caller for all of them is what keeps the initial mesh glare-free.
        const peers = (m["peers"] ?? []) as VoicePeer[];
        for (const p of peers) makeConn(p.peerId, /* polite */ false);
        return;
      }

      if (type === "voice:roster" && m["channel_id"] === joinedRef.current) {
        const participants = ((m["participants"] ?? []) as VoicePeer[]).filter(
          (p) => p.peerId !== myPeerId,
        );
        setState((s) => ({ ...s, peers: participants }));
        return;
      }

      if (type === "voice:peer_left") {
        closePeer(m["peer_id"] as string);
        return;
      }

      if (type === "voice:signal") {
        const from = m["from"] as string;
        const data = m["data"] as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
        // An inbound offer from someone we have not met: we are the callee and
        // therefore polite.
        const conn = conns.current.get(from) ?? makeConn(from, true);
        const { pc } = conn;

        try {
          if (data.description) {
            const offerCollision =
              data.description.type === "offer" && (conn.makingOffer || pc.signalingState !== "stable");
            conn.ignoreOffer = !conn.polite && offerCollision;
            if (conn.ignoreOffer) return;

            await pc.setRemoteDescription(data.description);
            if (data.description.type === "offer") {
              await pc.setLocalDescription();
              signal(from, { description: pc.localDescription });
            }
          } else if (data.candidate) {
            try {
              await pc.addIceCandidate(data.candidate);
            } catch {
              if (!conn.ignoreOffer) throw new Error("bad candidate");
            }
          }
        } catch (err) {
          setState((s) => ({ ...s, error: (err as Error).message }));
        }
      }
    };

    socket.addEventListener("message", onMessage);
    return () => socket.removeEventListener("message", onMessage);
  }, [socket, myPeerId, makeConn, closePeer, signal]);

  /* -------------------------------- actions ------------------------------ */

  const join = useCallback(
    async (channelId: string) => {
      if (!socket) return;
      try {
        localAudio.current = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        setState((s) => ({ ...s, error: `microphone unavailable: ${(err as Error).message}` }));
        return;
      }
      joinedRef.current = channelId;
      setState((s) => ({ ...s, channelId, error: null }));
      socket.send(JSON.stringify({ type: "voice:join", channel_id: channelId }));
    },
    [socket],
  );

  const leave = useCallback(() => {
    socket?.send(JSON.stringify({ type: "voice:leave" }));
    teardown();
  }, [socket, teardown]);

  const setMuted = useCallback(
    (muted: boolean) => {
      for (const t of localAudio.current?.getAudioTracks() ?? []) t.enabled = !muted;
      setState((s) => ({ ...s, muted }));
      socket?.send(JSON.stringify({ type: "voice:state", muted }));
    },
    [socket],
  );

  const startShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      localScreen.current = stream;
      for (const conn of conns.current.values()) {
        for (const track of stream.getTracks()) conn.pc.addTrack(track, stream);
      }
      // Stopping from the OS chrome must also tell everyone else.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => void stopShare());
      setState((s) => ({ ...s, sharing: true }));
      socket?.send(JSON.stringify({ type: "voice:state", sharing: true }));
    } catch (err) {
      setState((s) => ({ ...s, error: `screen share failed: ${(err as Error).message}` }));
    }
  }, [socket]);

  const stopShare = useCallback(async () => {
    const stream = localScreen.current;
    localScreen.current = null;
    stream?.getTracks().forEach((t) => t.stop());
    for (const conn of conns.current.values()) {
      for (const sender of conn.pc.getSenders()) {
        if (sender.track?.kind === "video") conn.pc.removeTrack(sender);
      }
    }
    setState((s) => ({ ...s, sharing: false }));
    socket?.send(JSON.stringify({ type: "voice:state", sharing: false }));
  }, [socket]);

  useEffect(() => teardown, [teardown]);

  return { state, join, leave, setMuted, startShare, stopShare };
}
