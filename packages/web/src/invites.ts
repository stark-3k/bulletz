/**
 * Invite links.
 *
 * A bare code leaves the person inviting to do the rest of the work: send
 * the code, and separately say which server to put it into. A code with no
 * server attached is not usable on its own, so half the instruction travels
 * out of band and usually arrives wrong. A link carries both.
 *
 * The code is still a code — the link is only a wrapper around it, so an old
 * one pasted into the box keeps working, and this never becomes the only way
 * in.
 */
export type Invite = { server: string | null; code: string };

/**
 * Pull an invite out of whatever someone pasted — a link, or just the code.
 *
 * Deliberately tolerant about the shape and strict about the scheme: a link
 * decides which server the app talks to next, so anything that is not plain
 * http or https is not a link we will follow.
 */
export function parseInvite(raw: string): Invite | null {
  const text = raw.trim();
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (!/^https?:$/.test(url.protocol)) return null;
      const m = /\/invite\/([^/?#]+)/.exec(url.pathname);
      const code = m?.[1] ? decodeURIComponent(m[1]) : (url.searchParams.get("code") ?? "");
      if (!code) return null;
      return { server: url.origin, code };
    } catch {
      return null;
    }
  }

  // Anything else carrying a scheme is not a code and not a link we follow.
  // It could do no harm — a non-http link yields no server, so nothing ever
  // navigates to it — but calling `javascript:…` an invite code and sending
  // it to the server is not an honest reading of what someone pasted.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;

  // A bare code. Keeps every invite issued before links existed working.
  return { server: null, code: text };
}

const PENDING = "bulletz.invite.pending";

/**
 * The invite this window was opened with — from the address bar in a browser,
 * or from the handoff below in the desktop app.
 *
 * The packaged app's renderer is loaded over file://, where a path like
 * /invite/<code> means the filesystem root and navigating to one produces a
 * blank window rather than a route. So the URL is read where there is one and
 * ignored where there is not, and the desktop carries the code across its
 * reload in session storage instead.
 */
export function inviteFromLocation(): string | null {
  try {
    const m = /^\/invite\/([^/?#]+)/.exec(location.pathname);
    if (m?.[1]) return decodeURIComponent(m[1]);
  } catch {
    /* no usable location; fall through to the handoff */
  }
  try {
    return sessionStorage.getItem(PENDING);
  } catch {
    return null;
  }
}

/** Hold an invite across the reload that points this window at its server. */
export function holdInvite(code: string) {
  try {
    sessionStorage.setItem(PENDING, code);
  } catch {
    /* without it the code is still in the field; only the reload loses it */
  }
}

function releaseInvite() {
  try {
    sessionStorage.removeItem(PENDING);
  } catch {
    /* ignore */
  }
}

/**
 * Drop the invite out of the address bar once it has been read.
 *
 * Otherwise a reload re-opens a link whose code has by then been spent, and
 * the person is told their invite is invalid immediately after it worked.
 */
export function clearInviteFromLocation() {
  releaseInvite();
  try {
    if (/^\/invite\//.test(location.pathname)) history.replaceState(null, "", "/");
  } catch {
    /* file:// has no path to clear; the handoff above is already released */
  }
}
