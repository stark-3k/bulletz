/**
 * Which server am I talking to?
 *
 * This used to be a build-time constant, which meant a packaged desktop app
 * could only ever reach whatever URL was baked into it. For a tool whose whole
 * point is a team pointing at their own VPS, that is not a setting — it is the
 * first question the app has to answer, before there is anything to sign in to.
 */

import { activeAccount, isAddingWorkspace } from "./accounts.ts";

const KEY = "bulletz.server";

/** Accepts what people actually type: "box.example.com", "box:4000", a full URL. */
export function normaliseServer(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return "";
  // A bare host gets https, except on the loopback names, where nobody is
  // running a certificate and http is what the dev server actually serves.
  if (!/^https?:\/\//i.test(v)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(v);
    return `${local ? "http" : "https"}://${v}`;
  }
  return v;
}

/** The user's explicit choice, if they have made one. */
export function savedServer(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // private mode, blocked storage — fall through to the defaults
  }
}

/** Where the current answer came from. "none" is the one that matters: a
 *  downloaded app on first launch has no basis for a guess, and guessing
 *  localhost just to fail is how you greet a new user with an error page. */
export type ServerSource = "account" | "saved" | "host" | "pinned" | "origin" | "dev" | "none";

/** The desktop main process hands its stored choice to the renderer at launch,
 *  because a packaged app loads over file:// and has no origin to infer from. */
function hostServer(): string | null {
  const w = globalThis as unknown as { bulletz?: { initialServer?: string | null } };
  const v = w.bulletz?.initialServer;
  return typeof v === "string" && v ? v : null;
}

export function serverSource(): ServerSource {
  // While joining another workspace the explicit choice wins: the whole point
  // is to reach a server the signed-in account knows nothing about.
  if (isAddingWorkspace() && savedServer()) return "saved";
  // Otherwise a signed-in workspace settles it outright: its server is the
  // server, whatever the build or the origin would suggest.
  if (activeAccount()) return "account";
  if (savedServer()) return "saved";
  if (hostServer()) return "host";
  if (import.meta.env.VITE_BULLETZ_URL) return "pinned";
  if (!import.meta.env.DEV && /^https?:$/.test(location.protocol)) return "origin";
  if (import.meta.env.DEV) return "dev";
  return "none";
}

export function resolveServer(): string {
  const saved = savedServer();
  // See serverSource(): mid-add, the explicit choice outranks the account.
  if (isAddingWorkspace() && saved) return saved;

  const account = activeAccount();
  if (account) return account.serverUrl;

  if (saved) return saved;

  // The desktop app's own record, for the packaged case where localStorage is
  // empty but main already knows which server this install belongs to.
  const host = hostServer();
  if (host) return normaliseServer(host);

  // A build can still pin a server — that is how you ship a desktop app
  // preconfigured for one team.
  const pinned = import.meta.env.VITE_BULLETZ_URL as string | undefined;
  if (pinned) return normaliseServer(pinned);

  // Served over http(s) and not by the dev server: the page came FROM the
  // server, so that is the server. This is the deployed-to-a-VPS case, and
  // getting it wrong is why a deployed build used to call localhost.
  if (!import.meta.env.DEV && /^https?:$/.test(location.protocol)) {
    return location.origin;
  }

  // Only meaningful while developing. A packaged app reaching this line has
  // nothing to connect to, which is what serverSource() === "none" reports.
  return "http://localhost:4000";
}

export function setServer(url: string) {
  try {
    localStorage.setItem(KEY, normaliseServer(url));
  } catch {
    /* nothing we can do; the caller reloads either way */
  }
}

export function clearServer() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export type Probe =
  | { ok: true; url: string; needsSetup: boolean; connections: number }
  | { ok: false; url: string; error: string };

/**
 * Is there a Bulletz server there? Checks /health AND /v1/bootstrap, because
 * reaching *something* at that address proves nothing — pointing at a random
 * web host should fail here, not three screens later.
 */
export async function probeServer(raw: string, timeoutMs = 6000): Promise<Probe> {
  const url = normaliseServer(raw);
  if (!url) return { ok: false, url, error: "Enter a server address." };
  // `new URL` alone is too permissive: it percent-encodes spaces and happily
  // accepts "https://not a url", which then fails later as a confusing
  // network error instead of the typo it actually is.
  if (/\s/.test(raw.trim())) return { ok: false, url, error: "An address cannot contain spaces." };
  try {
    const u = new URL(url);
    if (!u.hostname || !/^[a-z0-9.\-[\]:]+$/i.test(u.hostname)) {
      return { ok: false, url, error: "That is not a valid address." };
    }
  } catch {
    return { ok: false, url, error: "That is not a valid address." };
  }

  const stop = AbortSignal.timeout(timeoutMs);
  try {
    const health = await fetch(`${url}/health`, { signal: stop });
    if (!health.ok) return { ok: false, url, error: `Server answered ${health.status}.` };
    const h = (await health.json()) as { ok?: boolean; connections?: number };
    if (h.ok !== true) return { ok: false, url, error: "That address is not a Bulletz server." };

    const boot = await fetch(`${url}/v1/bootstrap`, { signal: stop });
    if (!boot.ok) return { ok: false, url, error: "That address is not a Bulletz server." };
    const b = (await boot.json()) as { needsSetup?: boolean };
    if (typeof b.needsSetup !== "boolean") {
      return { ok: false, url, error: "That address is not a Bulletz server." };
    }
    return { ok: true, url, needsSetup: b.needsSetup, connections: h.connections ?? 0 };
  } catch (e) {
    const err = e as Error;
    // The three failures worth telling apart, because the fix differs: wrong
    // address, server down, and a browser blocking the request.
    if (err.name === "TimeoutError") return { ok: false, url, error: "No answer — is the server running?" };
    if (url.startsWith("https://") && location.protocol === "http:") {
      return { ok: false, url, error: "Could not reach it. Mixed http/https can block this." };
    }
    return { ok: false, url, error: "Could not reach it. Check the address, port, and that it is running." };
  }
}
