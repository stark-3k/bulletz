import type { Decision, Event, Note, Task, Channel } from "@bulletz/shared";

import { resolveServer } from "./server.ts";

// Resolved once per load. Changing servers reloads the app rather than trying
// to re-point live sockets, caches, and an in-flight event stream at a
// different workspace — that path is all risk and no benefit.
const BASE = resolveServer();

export type Constraint = {
  id: string;
  rule: string;
  rationale: string | null;
  status: string;
  created_at: string;
};

export type ProjectLink = {
  id: string;
  kind: string;
  label: string;
  url: string;
  notes: string | null;
};

export type SessionRow = {
  id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  current?: boolean;
};

export type TokenRow = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  actor_handle: string;
};

export type Project = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  links: ProjectLink[];
};

export type Member = {
  id: string;
  handle: string;
  display_name: string;
  email: string | null;
  kind: "human" | "agent" | "integration";
  role: "owner" | "admin" | "member" | "guest";
  status: "active" | "disabled";
  owner_actor_id: string | null;
  active_sessions: number;
  created_at: string;
};

export type Invite = {
  id: string;
  role: string;
  note: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_handle: string | null;
};

export type Presence = {
  handle: string;
  kind: string;
  display_name: string;
  branch: string | null;
  cwd: string | null;
  dirty_files: number | null;
  test_status: string | null;
  agent_kind: string | null;
  online: boolean;
};

/** Unauthenticated calls: sign-in happens before there is an Api instance. */
export const bootstrap = {
  status: () =>
    fetch(`${BASE}/v1/bootstrap`).then((r) => r.json() as Promise<{ needsSetup: boolean }>),
  create: (body: {
    workspace: string;
    handle: string;
    password: string;
    display_name?: string;
    email?: string;
  }) => post("/bootstrap", body),
};

export const auth = {
  login: (handle: string, password: string) => post("/auth/login", { handle, password }),
  accept: (body: { code: string; handle: string; password: string; display_name?: string; email?: string }) =>
    post("/auth/accept", body),
  reset: (code: string, password: string) => post("/auth/reset", { code, password }),
};

async function post(path: string, body: unknown): Promise<{ token: string; expires_at: string }> {
  const res = await fetch(`${BASE}/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  return JSON.parse(text) as { token: string; expires_at: string };
}

export class Api {
  constructor(private token: string) {}

  /** Exposed so the voice layer can fetch its own ICE config. */
  get baseUrl() {
    return BASE;
  }
  get authToken() {
    return this.token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      // The server already says what went wrong in `error`; showing the raw
      // JSON envelope instead makes a clear message look like a crash.
      const raw = await res.text();
      let message = raw.slice(0, 200);
      try {
        const body = JSON.parse(raw) as { error?: string; issues?: { path: string; message: string }[] };
        message =
          body.error ??
          body.issues?.map((i) => `${i.path}: ${i.message}`).join(", ") ??
          message;
      } catch {
        /* not json — show what came back */
      }
      throw new Error(message);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  logout = () => this.call("POST", "/auth/logout", {});
  updateMe = (patch: { display_name?: string; email?: string | null }) =>
    this.call<{ actor: Member }>("PATCH", "/me", patch);
  changePassword = (current: string | undefined, next: string) =>
    this.call("POST", "/auth/password", { ...(current ? { current } : {}), next });
  sessions = () => this.call<{ sessions: SessionRow[] }>("GET", "/auth/sessions");
  revokeSession = (id: string) => this.call("DELETE", `/auth/sessions/${id}`);
  apiTokens = () => this.call<{ tokens: TokenRow[] }>("GET", "/api-tokens");
  createApiToken = (name: string) =>
    this.call<{ id: string; name: string; token: string }>("POST", "/api-tokens", { name });
  revokeApiToken = (id: string) => this.call("DELETE", `/api-tokens/${id}`);
  resetMember = (id: string) =>
    this.call<{ code: string; handle: string; expires_at: string }>("POST", `/members/${id}/reset`, {});
  onboarding = () => this.call<import("./Onboarding.tsx").OnboardingState>("GET", "/onboarding");
  createAgentToken = () =>
    this.call<{ token: string; agent_handle: string }>("POST", "/onboarding/agent-token", {});
  members = () => this.call<{ members: Member[] }>("GET", "/members");
  invites = () => this.call<{ invites: Invite[] }>("GET", "/invites");
  createInvite = (role: string, note?: string) =>
    this.call<{ id: string; code: string; role: string; expires_at: string }>("POST", "/invites", {
      role,
      ...(note ? { note } : {}),
    });
  revokeInvite = (id: string) => this.call("DELETE", `/invites/${id}`);
  updateMember = (id: string, patch: { role?: string; status?: string }) =>
    this.call<{ member: Member }>("PATCH", `/members/${id}`, patch);

  me = () =>
    this.call<{
      actor: {
        id: string;
        handle: string;
        kind: string;
        workspace_id: string;
        role: Member["role"];
      };
    }>("GET", "/me");
  channels = (includeArchived = false) =>
    this.call<{ channels: Channel[] }>(
      "GET",
      `/channels${includeArchived ? "?include_archived=true" : ""}`,
    );
  createChannel = (title: string) => this.call<{ channel: Channel }>("POST", "/channels", { title });
  setChannelStatus = (id: string, status: "open" | "archived") =>
    this.call<{ channel: Channel }>("PATCH", `/channels/${id}`, { status });
  channelEvents = (id: string) =>
    this.call<{ channel: Channel; events: Event[] }>("GET", `/channels/${id}/events?limit=200`);
  thread = (rootId: string) =>
    this.call<{ root: Event; replies: Event[] }>("GET", `/threads/${rootId}`);
  postReply = (rootId: string, body: string) =>
    this.call<{ event: Event }>("POST", "/events", { reply_to: rootId, kind: "message", body });

  postMessage = (channelId: string, body: string) =>
    this.call<{ event: Event }>("POST", "/events", { channel_id: channelId, kind: "message", body });
  editMessage = (id: string, body: string) =>
    this.call<{ event: Event }>("PATCH", `/events/${id}`, { body });
  deleteMessage = (id: string) => this.call("DELETE", `/events/${id}`);

  decisions = () => this.call<{ decisions: Decision[] }>("GET", "/decisions?include_superseded=true");
  createDecision = (input: { statement: string; rationale?: string; channel_id?: string }) =>
    this.call<{ decision: Decision }>("POST", "/decisions", input);
  constraints = () => this.call<{ constraints: Constraint[] }>("GET", "/constraints");
  createConstraint = (input: { rule: string; rationale?: string }) =>
    this.call("POST", "/constraints", input);
  tasks = () => this.call<{ tasks: Task[] }>("GET", "/tasks");
  createTask = (input: { title: string; channel_id?: string }) =>
    this.call<{ task: Task }>("POST", "/tasks", input);
  updateTask = (id: string, status: string) =>
    this.call<{ task: Task }>("PATCH", `/tasks/${id}`, { status });

  notes = (includeArchived = false) =>
    this.call<{ notes: Note[] }>(
      "GET",
      `/notes${includeArchived ? "?include_archived=true" : ""}`,
    );
  createNote = (input: { title?: string; body?: string; channel_id?: string }) =>
    this.call<{ note: Note }>("POST", "/notes", input);
  updateNote = (
    id: string,
    patch: {
      title?: string;
      body?: string;
      labels?: string[];
      pinned?: boolean;
      status?: "active" | "archived";
    },
  ) => this.call<{ note: Note }>("PATCH", `/notes/${id}`, patch);

  presence = () => this.call<{ presence: Presence[] }>("GET", "/presence");

  project = () => this.call<Project>("GET", "/project");
  setProjectSummary = (summary: string) => this.call("PUT", "/project", { summary });
  addProjectLink = (l: { kind: string; label: string; url: string; notes?: string }) =>
    this.call("POST", "/project/links", l);

  widgets = () => this.call<{ widgets: unknown[] }>("GET", "/widgets");
  widgetData = (id: string) => this.call<{ rows: unknown[]; ms: number }>("GET", `/widgets/${id}/data`);
  widgetHtml = (id: string) => this.call<{ html: string }>("GET", `/widgets/${id}/html`);
  activateWidget = (id: string) => this.call("POST", `/widgets/${id}/activate`, {});
  tools = () => this.call<{ tools: unknown[] }>("GET", "/tools");
  activateTool = (id: string) => this.call("POST", `/tools/${id}/activate`, {});

  stream(onMessage: (m: unknown) => void, onOpen: () => void, onClose: () => void) {
    const url = `${BASE.replace(/^http/, "ws")}/v1/stream?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onClose);
    ws.addEventListener("message", (e) => onMessage(JSON.parse(e.data as string)));
    return ws;
  }
}
