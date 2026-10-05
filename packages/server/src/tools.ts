import { maybeOne, pool, q } from "./db.js";

export type ToolImpl =
  | { kind: "sql"; query: string }
  | {
      kind: "http";
      method?: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      extract?: string;
    };

export type ToolRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  impl: ToolImpl;
  egress_allow: string[];
  status: "draft" | "active" | "disabled";
  created_at: string;
};

export class ToolError extends Error {}

/* ------------------------------- sql impl ------------------------------- */

/** Read-only by construction, not by convention: single statement, must begin
 *  with select/with, runs in a read-only transaction with a hard timeout, and
 *  $1 is always the caller's workspace so a query cannot reach another tenant. */
function assertReadOnlySql(sql: string) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) throw new ToolError("sql tools must be a single statement");
  if (!/^(select|with)\b/i.test(trimmed)) throw new ToolError("sql tools must start with SELECT or WITH");
  if (/\b(insert|update|delete|drop|alter|create|grant|truncate|copy)\b/i.test(trimmed)) {
    throw new ToolError("sql tools may not contain write statements");
  }
  return trimmed;
}

async function runSql(sql: string, workspaceId: string, args: Record<string, unknown>) {
  const text = assertReadOnlySql(sql);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    await client.query("set local statement_timeout = '4s'");
    const res = await client.query(text, [workspaceId, JSON.stringify(args)]);
    await client.query("rollback");
    return res.rows;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err instanceof ToolError ? err : new ToolError(String((err as Error).message));
  } finally {
    client.release();
  }
}

/* ------------------------------- http impl ------------------------------ */

const hostAllowed = (url: string, allow: string[]) => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new ToolError(`invalid url: ${url}`);
  }
  return allow.some((d) => {
    const dom = d.toLowerCase();
    return host === dom || host.endsWith(`.${dom}`);
  });
};

/** Substitutes {{secret.NAME}} from the server-side vault. Secrets are resolved
 *  here, at call time — they never appear in a tool definition a model can read. */
async function substitute(input: string, workspaceId: string) {
  const names = [...input.matchAll(/\{\{secret\.([A-Z0-9_]+)\}\}/g)].map((m) => m[1]!);
  if (!names.length) return input;
  const rows = await q<{ name: string; value: string }>(
    `select name, value from tool_secrets where workspace_id = $1 and name = any($2::text[])`,
    [workspaceId, names],
  );
  const map = new Map(rows.map((r) => [r.name, r.value]));
  return input.replace(/\{\{secret\.([A-Z0-9_]+)\}\}/g, (_m, n: string) => {
    const v = map.get(n);
    if (v === undefined) throw new ToolError(`missing secret: ${n}`);
    return v;
  });
}

const interpolateArgs = (s: string, args: Record<string, unknown>) =>
  s.replace(/\{\{args\.([A-Za-z0-9_]+)\}\}/g, (_m, k: string) => String(args[k] ?? ""));

async function runHttp(impl: Extract<ToolImpl, { kind: "http" }>, tool: ToolRow, args: Record<string, unknown>) {
  const url = await substitute(interpolateArgs(impl.url, args), tool.workspace_id);
  if (!hostAllowed(url, tool.egress_allow)) {
    throw new ToolError(`host not in egress_allow for tool ${tool.name}`);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(impl.headers ?? {})) {
    headers[k] = await substitute(interpolateArgs(v, args), tool.workspace_id);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: impl.method ?? "GET",
      headers,
      ...(impl.body === undefined
        ? {}
        : { body: await substitute(interpolateArgs(JSON.stringify(impl.body), args), tool.workspace_id) }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ToolError(`${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return [{ value: text.slice(0, 5000) }];
    }
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------- runner -------------------------------- */

export async function getTool(workspaceId: string, idOrName: string): Promise<ToolRow | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrName);
  return maybeOne<ToolRow>(
    `select id, workspace_id, name, description, input_schema, impl, egress_allow, status, created_at
       from tools where workspace_id = $1 and ${byId ? "id = $2::uuid" : "name = $2"}`,
    [workspaceId, idOrName],
  );
}

export async function invokeTool(
  tool: ToolRow,
  args: Record<string, unknown>,
): Promise<{ rows: unknown[]; ms: number }> {
  if (tool.status !== "active") {
    throw new ToolError(`tool "${tool.name}" is ${tool.status} — a human must activate it first`);
  }
  const started = Date.now();
  const out =
    tool.impl.kind === "sql"
      ? await runSql(tool.impl.query, tool.workspace_id, args)
      : await runHttp(tool.impl, tool, args);
  const rows = Array.isArray(out) ? out : [out];
  return { rows, ms: Date.now() - started };
}
