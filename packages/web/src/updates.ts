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

/**
 * The releases list, not /releases/latest.
 *
 * GitHub's "latest" endpoint deliberately skips prereleases — while every
 * build is a beta it returns 404, and the check silently never fires. Asking
 * for the list and choosing here also lets the rule be the sensible one:
 * someone on a prerelease hears about prereleases, someone on a stable
 * release is not nagged toward a beta.
 */
const RELEASES = "https://api.github.com/repos/stark-3k/bulletz/releases?per_page=20";
const DISMISSED = "bulletz.update.dismissed";
const LAST_CHECK = "bulletz.update.checked";
const FOUND = "bulletz.update.found";
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

const isPrerelease = (v: string) => /-/.test(v.trim().replace(/^v/, ""));

async function fetchLatest(current: string, signal: AbortSignal): Promise<Release | null> {
  const res = await fetch(RELEASES, { signal, headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const list = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
  }[];
  if (!Array.isArray(list)) return null;

  const wantPre = isPrerelease(current);
  let best: Release | null = null;
  for (const r of list) {
    if (r.draft || !r.tag_name || !r.html_url) continue;
    // Running a stable build should not be nudged onto a beta.
    if (r.prerelease && !wantPre) continue;
    if (!isNewer(r.tag_name, current)) continue;
    if (best && !isNewer(r.tag_name, best.version)) continue;
    best = { version: r.tag_name, url: r.html_url, notes: r.body ?? null };
  }
  return best;
}

/**
 * Returns a notification when a newer version exists and has not been
 * dismissed. Throttled, because the releases API is rate limited for
 * unauthenticated callers and nobody needs this answered on every mount.
 */
export async function checkForUpdate(
  currentVersion: string,
  force = false,
): Promise<LocalNotification | null> {
  if (!currentVersion) return null;
  try {
    const last = Number(localStorage.getItem(LAST_CHECK) ?? 0);
    if (!force && Date.now() - last < EVERY_MS) {
      // Still surface a previously-found update that was never dismissed.
      const cached = localStorage.getItem(FOUND);
      if (!cached) return null;
      const rel = JSON.parse(cached) as Release;
      return isNewer(rel.version, currentVersion) && localStorage.getItem(DISMISSED) !== rel.version
        ? toNotification(rel)
        : null;
    }

    const rel = await fetchLatest(currentVersion, AbortSignal.timeout(8000));
    localStorage.setItem(LAST_CHECK, String(Date.now()));
    if (!rel) {
      localStorage.removeItem(FOUND);
      return null;
    }
    localStorage.setItem(FOUND, JSON.stringify(rel));
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


/**
 * The same question, asked for a settings panel rather than the bell: what is
 * running, is there something newer, and did the check even work. A silent
 * null is right for a notification and useless in a panel someone opened
 * specifically to find out.
 */
export type UpdateStatus =
  | { state: "current"; version: string }
  | { state: "available"; version: string; latest: Release }
  | { state: "unknown"; version: string; reason: string };

export async function updateStatus(currentVersion: string): Promise<UpdateStatus> {
  if (!currentVersion) return { state: "unknown", version: "", reason: "Unknown version." };
  try {
    const rel = await fetchLatest(currentVersion, AbortSignal.timeout(8000));
    localStorage.setItem(LAST_CHECK, String(Date.now()));
    if (rel) {
      localStorage.setItem(FOUND, JSON.stringify(rel));
      return { state: "available", version: currentVersion, latest: rel };
    }
    localStorage.removeItem(FOUND);
    return { state: "current", version: currentVersion };
  } catch {
    return {
      state: "unknown",
      version: currentVersion,
      reason: "Could not reach GitHub to check.",
    };
  }
}
