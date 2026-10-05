import type { SearchHit } from "@bulletz/shared";
import { q } from "./db.js";
import { getProject, listConstraints, listDecisions, listTasks, threadEvents } from "./repo.js";

/** Unit weights. Extracted units rank above raw chat on purpose: a decision is
 *  worth more to a caller than the twelve messages that produced it. */
const WEIGHTS = { decision: 3.0, constraint: 2.5, task: 1.6, rollup: 1.4, event: 1.0 };

/** Postgres `websearch_to_tsquery` ANDs every term, so one unmatched word
 *  returns nothing — useless for an agent asking a loose question. We OR the
 *  bare terms in for recall and let ts_rank sort precision back out: rows
 *  matching every term still score highest. */
function recallQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1);
  return [...new Set(terms)].join(" | ");
}

/** Hybrid-ready lexical search across the log and its projections.
 *  No model is involved: this is the hot path, called on every agent turn.
 *  Vector search joins this as an extra CTE + RRF fusion later. */
export async function search(
  workspaceId: string,
  input: {
    query: string;
    thread_id?: string | undefined;
    kinds?: string[] | undefined;
    since?: string | undefined;
    limit: number;
    include_superseded: boolean;
  },
): Promise<SearchHit[]> {
  const rows = await q<SearchHit & { score: string }>(
    `
    with tsq as (
      select case
               when $8::text = '' then websearch_to_tsquery('english', $2)
               else websearch_to_tsquery('english', $2) || to_tsquery('english', $8::text)
             end as query
    ),
    -- recency decay: a 30-day-old unit scores half what today's does
    ev as (
      select 'event'::text as unit, e.id::text, ts_rank(e.search, tsq.query) as rank,
             null::text as title, coalesce(e.body,'') as text, e.thread_id,
             a.handle as actor_handle, e.created_at,
             array[e.id::text] as source_event_ids
        from events e join actors a on a.id = e.actor_id, tsq
       where e.workspace_id = $1 and e.search @@ tsq.query
         and ($3::uuid is null or e.thread_id = $3::uuid)
         and ($4::text[] is null or e.kind = any($4::text[]))
         and ($5::timestamptz is null or e.created_at >= $5::timestamptz)
    ),
    dec as (
      select 'decision'::text, d.id::text, ts_rank(d.search, tsq.query),
             d.statement as title,
             coalesce(d.statement,'') || case when d.rationale is null then ''
               else E'\nWhy: ' || d.rationale end as text,
             d.thread_id, a.handle, d.decided_at as created_at,
             coalesce(array(select x::text from unnest(d.source_event_ids) x), '{}') 
        from decisions d left join actors a on a.id = d.decided_by, tsq
       where d.workspace_id = $1 and d.search @@ tsq.query
         and ($6::boolean or d.status in ('accepted','proposed'))
         and ($3::uuid is null or d.thread_id = $3::uuid)
    ),
    con as (
      select 'constraint'::text, c.id::text, ts_rank(c.search, tsq.query),
             c.rule as title,
             coalesce(c.rule,'') || case when c.rationale is null then ''
               else E'\nWhy: ' || c.rationale end as text,
             null::uuid, null::text, c.created_at,
             coalesce(array(select x::text from unnest(c.source_event_ids) x), '{}')
        from project_constraints c, tsq
       where c.workspace_id = $1 and c.search @@ tsq.query and c.status = 'active'
    ),
    tk as (
      select 'task'::text, t.id::text, ts_rank(t.search, tsq.query),
             t.title, coalesce(t.title,'') || E'\n' || coalesce(t.body,'') as text,
             t.thread_id, null::text, t.updated_at as created_at, '{}'::text[]
        from tasks t, tsq
       where t.workspace_id = $1 and t.search @@ tsq.query
         and t.status not in ('done','cancelled')
    ),
    all_units as (select * from ev union all select * from dec
                  union all select * from con union all select * from tk)
    select unit, id, title, text, thread_id, actor_handle, created_at, source_event_ids,
           (rank
             * case unit when 'decision' then ${WEIGHTS.decision}
                         when 'constraint' then ${WEIGHTS.constraint}
                         when 'task' then ${WEIGHTS.task}
                         else ${WEIGHTS.event} end
             * (1.0 / (1.0 + extract(epoch from (now() - created_at)) / 2592000.0))
           ) as score
      from all_units
     order by score desc
     limit $7`,
    [
      workspaceId,
      input.query,
      input.thread_id ?? null,
      input.kinds ?? null,
      input.since ?? null,
      input.include_superseded,
      input.limit,
      recallQuery(input.query),
    ],
  );
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** A context pack is a context policy, executed. One call gives an agent what
 *  the project knows: durable rules, current decisions, live work, and the
 *  thread it is standing in. This is what makes a fresh agent competent. */
export async function contextPack(
  workspaceId: string,
  opts: { thread_id?: string | undefined; query?: string | undefined; budget?: number } = {},
) {
  const [project, constraints, decisions, tasks] = await Promise.all([
    getProject(workspaceId),
    listConstraints(workspaceId, 25),
    listDecisions(workspaceId, { limit: 20 }),
    listTasks(workspaceId, { status: ["open", "in_progress", "blocked"], limit: 25 }),
  ]);

  const thread = opts.thread_id
    ? {
        id: opts.thread_id,
        events: await threadEvents(workspaceId, opts.thread_id, { limit: 40 }),
      }
    : null;

  const relevant = opts.query
    ? await search(workspaceId, {
        query: opts.query,
        limit: 12,
        include_superseded: false,
        thread_id: undefined,
        kinds: undefined,
        since: undefined,
      })
    : [];

  return { project, constraints, decisions, tasks, thread, relevant };
}

/** Renders a context pack as the markdown an agent actually reads. Kept on the
 *  server so every client and every agent sees the same shape. */
export function renderContextPack(pack: Awaited<ReturnType<typeof contextPack>>): string {
  const out: string[] = [];

  // Identity first: what this is and where it lives. An agent that reads
  // nothing else should still come away knowing those two things.
  out.push(`# ${pack.project.name}`);
  if (pack.project.summary) out.push("", pack.project.summary);
  if (pack.project.links.length) {
    out.push("", "## Where it lives");
    for (const l of pack.project.links) {
      out.push(`- ${l.kind}: [${l.label}](${l.url})${l.notes ? ` — ${l.notes}` : ""}`);
    }
  }
  out.push("");

  if (pack.constraints.length) {
    out.push("## Project constraints (durable rules — do not violate)");
    for (const c of pack.constraints as Array<Record<string, string>>) {
      out.push(`- ${c.rule}${c.rationale ? ` — _${c.rationale}_` : ""}`);
    }
    out.push("");
  }

  if (pack.decisions.length) {
    out.push("## Current decisions");
    for (const d of pack.decisions) {
      const who = d.decided_by_handle ? ` (${d.decided_by_handle})` : "";
      out.push(`- **${d.statement}**${who}`);
      if (d.rationale) out.push(`  - why: ${d.rationale}`);
      out.push(`  - decision id: \`${d.id}\``);
    }
    out.push("");
  }

  if (pack.tasks.length) {
    out.push("## Open work");
    for (const t of pack.tasks) {
      const labels = t.labels.length ? ` [${t.labels.join(", ")}]` : "";
      out.push(`- (${t.status})${labels} ${t.title} — \`${t.id}\``);
    }
    out.push("");
  }

  if (pack.relevant.length) {
    out.push("## Relevant context");
    for (const h of pack.relevant) {
      const text = h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text;
      out.push(`- [${h.unit}] ${h.actor_handle ? `${h.actor_handle}: ` : ""}${text.replace(/\n/g, " ")}`);
    }
    out.push("");
  }

  if (pack.thread) {
    out.push("## This thread");
    for (const e of pack.thread.events) {
      if (e.kind === "message") out.push(`- ${e.actor_handle}: ${e.body ?? ""}`);
      else out.push(`- (${e.kind}) ${e.actor_handle}: ${(e.body ?? "").slice(0, 200)}`);
    }
  }

  return out.join("\n").trim() || "_No project context recorded yet._";
}
