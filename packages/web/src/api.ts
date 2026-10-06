import type { Decision, Event, Task, Channel } from "@bulletz/shared";

const BASE = import.meta.env.VITE_BULLETZ_URL ?? "http://localhost:4000";

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

export type Project = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  links: ProjectLink[];
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
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  me = () =>
    this.call<{ actor: { id: string; handle: string; kind: string; workspace_id: string } }>("GET", "/me");
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
