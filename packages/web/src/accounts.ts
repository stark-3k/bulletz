/**
 * The workspaces this install is signed in to.
 *
 * A workspace lives on a server, and a server hosts exactly one — so being in
 * several workspaces means holding several (server, credential) pairs and
 * choosing which is active. That is deliberately not "one account with many
 * workspaces": there is no central directory, each server is somebody else's
 * machine, and the identity you have on one has nothing to do with the other.
 * Handles are unique per workspace, not globally; the same person is
 * `rishabh` here and could be `rk` there.
 */

const KEY = "bulletz.accounts";
const ADDING = "bulletz.adding";
const LEGACY_TOKEN = "bulletz.token";

export type Account = {
  /** Stable local id. Server plus actor, because the same person may hold two
   *  identities on one server and the same handle on two servers. */
  id: string;
  serverUrl: string;
  /** The human's credential for this workspace. */
  token: string;
  workspaceId: string;
  workspaceName: string;
  handle: string;
  actorId: string;
  role: string;
  /** The agent's own credential here, if one has been minted. Per workspace:
   *  an agent token is an identity in one workspace and meaningless in
   *  another, so there is no single "the agent token" any more. */
  agentToken?: string;
  addedAt: string;
  lastUsedAt: string;
};

type Store = { active: string | null; list: Account[] };

const EMPTY: Store = { active: null, list: [] };

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Store;
    if (!Array.isArray(parsed.list)) return EMPTY;
    return { active: parsed.active ?? null, list: parsed.list };
  } catch {
    return EMPTY;
  }
}

function write(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* blocked storage — the session still works, it just will not be remembered */
  }
}

export const accountId = (serverUrl: string, actorId: string) => `${serverUrl}#${actorId}`;

export function listAccounts(): Account[] {
  // Most recently used first: the switcher should not reorder under you while
  // you are reading it, but across sessions the useful one should be on top.
  return [...read().list].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export function activeAccount(): Account | null {
  const s = read();
  return s.list.find((a) => a.id === s.active) ?? null;
}

/** Add or refresh an account, and make it the active one. */
export function upsertAccount(a: Omit<Account, "id" | "addedAt" | "lastUsedAt">): Account {
  const s = read();
  const id = accountId(a.serverUrl, a.actorId);
  const now = new Date().toISOString();
  const existing = s.list.find((x) => x.id === id);
  const next: Account = existing
    ? { ...existing, ...a, id, lastUsedAt: now }
    : { ...a, id, addedAt: now, lastUsedAt: now };
  write({
    active: id,
    list: [...s.list.filter((x) => x.id !== id), next],
  });
  return next;
}

export function setActive(id: string): Account | null {
  const s = read();
  const found = s.list.find((a) => a.id === id);
  if (!found) return null;
  const now = new Date().toISOString();
  write({
    active: id,
    list: s.list.map((a) => (a.id === id ? { ...a, lastUsedAt: now } : a)),
  });
  return { ...found, lastUsedAt: now };
}

/** Sign out of one workspace. Returns the account that is active afterwards,
 *  which is the most recent survivor, or null when none are left. */
export function removeAccount(id: string): Account | null {
  const s = read();
  const list = s.list.filter((a) => a.id !== id);
  const next = s.active === id ? (list.length ? [...list].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0]! : null) : s.list.find((a) => a.id === s.active) ?? null;
  write({ active: next?.id ?? null, list });
  return next;
}

export function removeAll() {
  write(EMPTY);
}

export function setAgentToken(id: string, agentToken: string) {
  const s = read();
  write({ ...s, list: s.list.map((a) => (a.id === id ? { ...a, agentToken } : a)) });
}

/**
 * Carry a pre-accounts sign-in across.
 *
 * Before this existed there was one token in localStorage and one server. That
 * install must not be logged out by upgrading, so the old pair becomes the
 * first account as soon as we know who it belongs to.
 */
export function legacyToken(): string | null {
  try {
    return localStorage.getItem(LEGACY_TOKEN);
  } catch {
    return null;
  }
}

export function clearLegacyToken() {
  try {
    localStorage.removeItem(LEGACY_TOKEN);
  } catch {
    /* ignore */
  }
}

/** True when this install has never had an account or a legacy token. */
export function isFresh(): boolean {
  return read().list.length === 0 && !legacyToken();
}


/* --------------------------- adding a workspace --------------------------- */

/**
 * Joining a second workspace means pointing at a different server, and that
 * means a reload — the API base, the socket and every cache are fixed for the
 * life of the page. This flag survives the reload so the app comes back into
 * the add flow instead of silently returning to the workspace you were
 * already in, which is what it did before it existed.
 */
export function beginAddWorkspace() {
  try {
    sessionStorage.setItem(ADDING, "1");
  } catch {
    /* without it the flow still works, it just will not survive a reload */
  }
}

export function isAddingWorkspace(): boolean {
  try {
    return sessionStorage.getItem(ADDING) === "1";
  } catch {
    return false;
  }
}

export function endAddWorkspace() {
  try {
    sessionStorage.removeItem(ADDING);
  } catch {
    /* ignore */
  }
}
