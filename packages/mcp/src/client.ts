const BASE = (process.env.BULLETZ_SERVER_URL ?? "http://localhost:4000").replace(/\/$/, "");
const TOKEN = process.env.BULLETZ_TOKEN ?? "";

export class BulletzError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!TOKEN) throw new BulletzError("BULLETZ_TOKEN is not set");
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new BulletzError(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
};

export const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
};
