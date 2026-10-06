import { useEffect, useRef, useState } from "react";
import type { VoicePeer, VoiceState } from "./Voice.tsx";
import { bridge } from "./Terminal.tsx";

/** Remote audio needs a real element to play. One per peer, never rendered. */
function PeerAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function SharedScreen({ stream, who }: { stream: MediaStream; who: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="voice-screen">
      <video ref={ref} autoPlay playsInline muted />
      <span className="voice-screen-label">{who} is sharing</span>
    </div>
  );
}

function Tile({ peer, speaking }: { peer: VoicePeer; speaking: boolean }) {
  return (
    <div className={`voice-tile${speaking ? " speaking" : ""}`}>
      <span className="voice-avatar">{peer.handle.replace(/^agent-/, "").slice(0, 2).toUpperCase()}</span>
      <span className="voice-name">{peer.handle}</span>
      {peer.muted && <span className="voice-muted" title="muted">⊘</span>}
      {peer.sharing && <span className="voice-sharing" title="sharing screen">◱</span>}
    </div>
  );
}

export function VoiceBar({
  state,
  inChannel,
  onJoin,
  onLeave,
  onMute,
  onShare,
  onStopShare,
}: {
  state: VoiceState;
  inChannel: string | null;
  onJoin: () => void;
  onLeave: () => void;
  onMute: (m: boolean) => void;
  onShare: () => void;
  onStopShare: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [sources, setSources] = useState<{ id: string; name: string; thumbnail: string }[]>([]);
  const [permission, setPermission] = useState<string | null>(null);
  const joined = state.channelId !== null && state.channelId === inChannel;

  const pick = async () => {
    const screen = bridge()?.screen;
    if (!screen) return onShare(); // browser: the OS picker handles it
    const r = await screen.sources();
    if (r.error === "permission") return setPermission(r.status ?? "denied");
    if (r.error) return setPermission(r.error);
    setSources(r.sources ?? []);
    setPicking(true);
  };

  const choose = async (id: string) => {
    setPicking(false);
    await bridge()?.screen?.pick(id);
    onShare();
  };

  const sharer = state.peers.find((p) => p.sharing);
  const shared = sharer ? state.streams[sharer.peerId] : undefined;
  const screenStream = shared?.getVideoTracks().length ? shared : undefined;

  if (!joined) {
    return (
      <div className="voice-bar idle">
        <button className="voice-join" onClick={onJoin}>
          ◉ Join voice
        </button>
        {state.error && <span className="voice-error">{state.error}</span>}
      </div>
    );
  }

  return (
    <>
      <div className="voice-bar">
        <span className="voice-live">
          <span className="voice-dot" /> voice
        </span>
        <div className="voice-tiles">
          <Tile
            peer={{ actorId: "me", handle: "you", peerId: "me", muted: state.muted, sharing: state.sharing }}
            speaking={false}
          />
          {state.peers.map((p) => (
            <Tile key={p.peerId} peer={p} speaking={false} />
          ))}
        </div>
        <button className={`voice-ctl${state.muted ? " on" : ""}`} onClick={() => onMute(!state.muted)}>
          {state.muted ? "Unmute" : "Mute"}
        </button>
        <button
          className={`voice-ctl${state.sharing ? " on" : ""}`}
          onClick={() => (state.sharing ? onStopShare() : void pick())}
        >
          {state.sharing ? "Stop sharing" : "Share screen"}
        </button>
        <button className="voice-ctl leave" onClick={onLeave}>
          Leave
        </button>
        {state.error && <span className="voice-error">{state.error}</span>}
      </div>

      {screenStream && sharer && <SharedScreen stream={screenStream} who={sharer.handle} />}

      {Object.entries(state.streams).map(([peerId, stream]) => (
        <PeerAudio key={peerId} stream={stream} />
      ))}

      {permission && (
        <div className="share-picker" onClick={() => setPermission(null)}>
          <div className="share-picker-box" onClick={(e) => e.stopPropagation()}>
            <div className="share-picker-head">Screen Recording permission needed</div>
            <p className="share-perm-body">
              macOS gates screen capture per app, and it cannot be requested from code. Enable
              Bulletz under <strong>Privacy &amp; Security → Screen &amp; System Audio Recording</strong>,
              then relaunch the app — the permission only takes effect on a fresh launch.
            </p>
            <div className="share-perm-actions">
              <button className="send" onClick={() => void bridge()?.screen?.openSettings()}>
                Open System Settings
              </button>
              <button className="voice-ctl" onClick={() => setPermission(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <div className="share-picker" onClick={() => setPicking(false)}>
          <div className="share-picker-box" onClick={(e) => e.stopPropagation()}>
            <div className="share-picker-head">Choose what to share</div>
            <div className="share-picker-grid">
              {sources.map((s) => (
                <button key={s.id} className="share-source" onClick={() => void choose(s.id)}>
                  <img src={s.thumbnail} alt="" />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
