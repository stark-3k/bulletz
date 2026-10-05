import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api.ts";

export type ViewSpec = {
  type: "metric" | "bar" | "table" | "status_grid";
  title?: string;
  value_field?: string;
  label_field?: string;
  status_field?: string;
  detail_field?: string;
  unit?: string;
  columns?: string[];
  refresh_ms?: number;
};

export type WidgetRow = {
  id: string;
  name: string;
  description: string | null;
  kind: "view" | "html";
  tool_id: string | null;
  tool_name: string | null;
  tool_status: string | null;
  view: ViewSpec | null;
  status: "draft" | "active" | "disabled";
  pinned: boolean;
  created_by_handle: string | null;
};

type Row = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n);

/** Status is reserved and never carried by colour alone — each cell ships a
 *  glyph and a label beside the swatch. */
const STATUS = {
  ok: { color: "var(--status-good)", glyph: "●", label: "ok" },
  up: { color: "var(--status-good)", glyph: "●", label: "up" },
  passing: { color: "var(--status-good)", glyph: "●", label: "passing" },
  warn: { color: "var(--status-warning)", glyph: "▲", label: "warn" },
  degraded: { color: "var(--status-serious)", glyph: "▲", label: "degraded" },
  down: { color: "var(--status-critical)", glyph: "■", label: "down" },
  failing: { color: "var(--status-critical)", glyph: "■", label: "failing" },
} as const;

const statusOf = (v: unknown) => {
  const key = String(v ?? "").toLowerCase() as keyof typeof STATUS;
  return STATUS[key] ?? { color: "var(--fg-faint)", glyph: "○", label: String(v ?? "unknown") };
};

export function Widget({ widget, api }: { widget: WidgetRow; api: Api }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!widget.tool_id) return setRows([]);
    try {
      const r = await api.widgetData(widget.id);
      setRows(r.rows as Row[]);
      setMs(r.ms);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [api, widget.id, widget.tool_id]);

  // The refresh loop hits the server, never a model. A 30s tick must be free.
  useEffect(() => {
    void load();
    const every = widget.view?.refresh_ms;
    if (!every) return;
    const t = setInterval(() => void load(), every);
    return () => clearInterval(t);
  }, [load, widget.view?.refresh_ms]);

  return (
    <div className="widget">
      <div className="widget-head">
        <span className="widget-name">{widget.view?.title ?? widget.name}</span>
        {widget.status === "draft" && <span className="tag">draft</span>}
        <span className="widget-meta">
          {widget.created_by_handle}
          {widget.view?.refresh_ms ? ` · ${Math.round(widget.view.refresh_ms / 1000)}s` : ""}
          {ms !== null ? ` · ${ms}ms` : ""}
        </span>
      </div>

      {widget.status === "draft" ? (
        <div className="widget-gate">
          Draft — activate to run.{" "}
          {widget.tool_status && widget.tool_status !== "active" && (
            <>
              Its tool <code>{widget.tool_name}</code> is {widget.tool_status}.
            </>
          )}
        </div>
      ) : err ? (
        <div className="widget-err">{err}</div>
      ) : widget.kind === "html" ? (
        <HtmlWidget id={widget.id} api={api} />
      ) : rows === null ? (
        <div className="widget-loading">loading…</div>
      ) : (
        <View spec={widget.view!} rows={rows} />
      )}
    </div>
  );
}

function View({ spec, rows }: { spec: ViewSpec; rows: Row[] }) {
  if (!rows.length) return <div className="widget-loading">no rows</div>;

  if (spec.type === "metric") {
    const field = spec.value_field ?? Object.keys(rows[0]!)[0]!;
    return (
      <div className="w-metric">
        <span className="w-metric-value">{fmt(num(rows[0]![field]))}</span>
        {spec.unit && <span className="w-metric-unit">{spec.unit}</span>}
      </div>
    );
  }

  if (spec.type === "bar") {
    const keys = Object.keys(rows[0]!);
    const lf = spec.label_field ?? keys[0]!;
    const vf = spec.value_field ?? keys[1] ?? keys[0]!;
    const max = Math.max(...rows.map((r) => num(r[vf])), 1);
    return (
      <div className="w-bars">
        {rows.slice(0, 12).map((r, i) => (
          <div className="w-bar-row" key={i}>
            <span className="w-bar-label">{String(r[lf] ?? "")}</span>
            <span className="w-bar-track">
              <span className="w-bar-fill" style={{ width: `${(num(r[vf]) / max) * 100}%` }} />
            </span>
            <span className="w-bar-value">{fmt(num(r[vf]))}</span>
          </div>
        ))}
      </div>
    );
  }

  if (spec.type === "status_grid") {
    const keys = Object.keys(rows[0]!);
    const lf = spec.label_field ?? keys[0]!;
    const sf = spec.status_field ?? keys[1] ?? keys[0]!;
    return (
      <div className="w-grid">
        {rows.slice(0, 24).map((r, i) => {
          const s = statusOf(r[sf]);
          return (
            <div className="w-cell" key={i}>
              <span className="w-cell-glyph" style={{ color: s.color }}>
                {s.glyph}
              </span>
              <span className="w-cell-label">{String(r[lf] ?? "")}</span>
              <span className="w-cell-status" style={{ color: s.color }}>
                {s.label}
              </span>
              {spec.detail_field && <span className="w-cell-detail">{String(r[spec.detail_field] ?? "")}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  const cols = spec.columns?.length ? spec.columns : Object.keys(rows[0]!);
  return (
    <div className="w-table-wrap">
      <table className="w-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{String(r[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tier 2: author-supplied HTML. srcdoc WITHOUT allow-same-origin gives the
 *  frame a null origin — no cookies, no storage, no reach into the host page.
 *  Its only channel is postMessage, and data arrives from us, so the widget
 *  holds exactly its tool's permissions and nothing more. */
function HtmlWidget({ id, api }: { id: string; api: Api }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [height, setHeight] = useState(180);

  useEffect(() => {
    void api.widgetHtml(id).then((r) => setHtml(r.html));
  }, [api, id]);

  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const msg = e.data as { type?: string; height?: number };
      if (msg?.type === "resize" && typeof msg.height === "number") {
        setHeight(Math.max(60, Math.min(msg.height, 600)));
      }
      if (msg?.type === "data") {
        const r = await api.widgetData(id).catch(() => ({ rows: [] }));
        frame.current?.contentWindow?.postMessage({ type: "data", rows: r.rows }, "*");
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [api, id]);

  if (html === null) return <div className="widget-loading">loading…</div>;

  // The bridge must be defined BEFORE the author's markup: their inline script
  // runs at parse time, so a bridge appended afterwards is undefined when called.
  const doc = `<!doctype html><meta charset="utf-8">
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:10px;background:transparent;color:#e4e8f1;
       font:12px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}
  *{box-sizing:border-box}
</style>
<script>
  window.bulletz = { data: () => parent.postMessage({ type: "data" }, "*") };
<\/script>
<body>${html}
<script>
  const post = () => parent.postMessage({ type: "resize", height: document.body.scrollHeight + 12 }, "*");
  new ResizeObserver(post).observe(document.body); post();
<\/script>`;

  return (
    <iframe
      ref={frame}
      className="w-frame"
      style={{ height }}
      sandbox="allow-scripts"
      srcDoc={doc}
      title="widget"
    />
  );
}
