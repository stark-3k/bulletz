/**
 * Is there a newer build than the one running?
 *
 * This checks and tells; it does not install. macOS refuses to auto-update an
 * app that is not signed with a Developer ID, and these builds are ad-hoc
 * signed — so an updater here would work on Linux and Windows and silently
 * fail on the platform most people are using. Saying "0.1.1 is out, here it
 * is" works everywhere and does not pretend otherwise.
 */
import type { LocalNotification } from "./Notifications.tsx";

const RELEASES = "https://api.github.com/repos/stark-3k/bulletz/releases/latest";
const DISMISSED = "bulletz.update.dismissed";
const LAST_CHECK = "bulletz.update.checked";
const EVERY_MS = 6 * 60 * 60 * 1000; // four times a day is plenty for a desktop app

export type Release = { version: string; url: string; notes: string | null };

/** Compare two semver-ish versions, prerelease included. Returns true when
 *  `candidate` is newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return null;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ?? null,
    };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i]! !== b.nums[i]!) return a.nums[i]! > b.nums[i]!;
  }
  // Same numbers: a release beats a prerelease, and prereleases compare by
  // their dot-separated identifiers so beta.10 is newer than beta.9.
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  const ap = a.pre.split(".");
  const bp = b.pre.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx > ny;
    return x > y;
  }
  return false;
}

async function fetchLatest(signal: AbortSignal): Promise<Release | null> {
  const res = await fetch(RELEASES, {
    signal,
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
  if (!body.tag_name || !body.html_url) return null;
  return { version: body.tag_name, url: body.html_url, notes: body.body ?? null };
}

/**
 * Returns a notification when a newer version exists and has not been
 * dismissed. Throttled, because the releases API is rate limited for
 * unauthenticated callers and nobody needs this answered on every mount.
 */
export async function checkForUpdate(currentVersion: string): Promise<LocalNotification | null> {
  if (!currentVersion) return null;
  try {
    const last = Number(localStorage.getItem(LAST_CHECK) ?? 0);
    if (Date.now() - last < EVERY_MS) {
      // Still surface a previously-found update that was never dismissed.
      const cached = localStorage.getItem("bulletz.update.found");
      if (!cached) return null;
      const rel = JSON.parse(cached) as Release;
      return isNewer(rel.version, currentVersion) && localStorage.getItem(DISMISSED) !== rel.version
        ? toNotification(rel)
        : null;
    }

    const rel = await fetchLatest(AbortSignal.timeout(8000));
    localStorage.setItem(LAST_CHECK, String(Date.now()));
    if (!rel) return null;
    localStorage.setItem("bulletz.update.found", JSON.stringify(rel));
    if (!isNewer(rel.version, currentVersion)) return null;
    if (localStorage.getItem(DISMISSED) === rel.version) return null;
    return toNotification(rel);
  } catch {
    // Offline, rate limited, or the repo moved. None of those are worth
    // telling anyone about — the app works regardless.
    return null;
  }
}

function toNotification(rel: Release): LocalNotification {
  return {
    id: `update:${rel.version}`,
    kind: "system",
    local: true,
    url: rel.url,
    title: `${rel.version} is available`,
    body: "You are running an older build. Downloads are on the release page.",
    channel_id: null,
    event_id: null,
    from_handle: null,
    read_at: null,
    created_at: new Date().toISOString(),
  };
}

export function dismissUpdate(id: string) {
  const version = id.startsWith("update:") ? id.slice("update:".length) : id;
  try {
    localStorage.setItem(DISMISSED, version);
  } catch {
    /* dismissal is a convenience, not state worth failing over */
  }
}
