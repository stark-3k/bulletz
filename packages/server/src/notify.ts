/**
 * Who gets told, and about what.
 *
 * Fan-out happens on write rather than on read: the alternative is every
 * client polling "is there anything for me", which costs a query per person
 * per interval forever, to answer "no" almost every time.
 *
 * The rules are deliberately narrow. A notification is for something addressed
 * to *you* — your handle, your message, your task, your agent. Everything else
 * is a channel being busy, which is what the unread cursor is for. Notifying
 * on general activity is how people learn to ignore the bell.
 */
import { maybeOne, q } from "./db.js";
import { broadcast } from "./realtime.js";

export type NotifyKind = "mention" | "reply" | "task" | "agent" | "system";

export type Notification = {
  id: string;
  kind: NotifyKind;
  title: string;
  body: string | null;
  channel_id: string | null;
  event_id: string | null;
  from_handle: string | null;
  read_at: string | null;
  created_at: string;
};

/** Absent means on: an existing account opts into new kinds rather than
 *  silently missing them. */
function wants(prefs: Record<string, unknown> | null, kind: NotifyKind): boolean {
  return prefs?.[kind] !== false;
}

const EXCERPT = 140;
const excerpt = (s: string | null) =>
  !s ? null : s.length > EXCERPT ? `${s.slice(0, EXCERPT - 1)}…` : s;

/**
 * Handles mentioned in a message body.
 *
 * Deliberately not a parser for the whole grammar: `@agent` is a command, and
 * a handle inside a code fence is a code sample, not a summons.
 */
export function mentionedHandles(body: string | null): string[] {
  if (!body) return [];
  const withoutCode = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  const out = new Set<string>();
  for (const m of withoutCode.matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9._-]{1,39})\b/gi)) {
    const handle = m[2]!.toLowerCase().replace(/[.]+$/, "");
    if (handle !== "agent") out.add(handle);
  }
  return [...out];
}

type Recipient = { id: string; handle: string; notify_prefs: Record<string, unknown> | null };

/** Everyone eligible to be notified: active humans who have not muted this
 *  channel. Agents are excluded — they do not read an inbox. */
async function eligible(
  workspaceId: string,
  channelId: string | null,
  ids: string[],
  exclude: string | null = null,
): Promise<Recipient[]> {
  if (!ids.length) return [];
  return q<Recipient>(
    `select a.id, a.handle, a.notify_prefs
       from actors a
      where a.workspace_id = $1
        and a.id = any($2::uuid[])
        and a.kind = 'human'
        and a.status = 'active'
        -- Nobody is notified about their own doing. Filtered here rather than
        -- at each call site, so a new kind of notification cannot forget it.
        and ($4::uuid is null or a.id <> $4)
        and ($3::uuid is null or not exists (
              select 1 from channel_mutes m
               where m.actor_id = a.id and m.channel_id = $3))`,
    [workspaceId, ids, channelId, exclude],
  );
}

async function insert(
  workspaceId: string,
  to: Recipient,
  n: {
    kind: NotifyKind;
    title: string;
    body?: string | null;
    channelId?: string | null;
    eventId?: string | null;
    fromId?: string | null;
    fromHandle?: string | null;
  },
) {
  if (!wants(to.notify_prefs, n.kind)) return;
  const row = await maybeOne<Notification>(
    `insert into notifications
       (workspace_id, actor_id, kind, title, body, channel_id, event_id, from_actor_id, from_handle)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict do nothing
     returning id, kind, title, body, channel_id, event_id, from_handle, read_at, created_at`,
    [
      workspaceId,
      to.id,
      n.kind,
      n.title,
      n.body ?? null,
      n.channelId ?? null,
      n.eventId ?? null,
      n.fromId ?? null,
      n.fromHandle ?? null,
    ],
  );
  // `on conflict do nothing` means a retry returns nothing; that is a success,
  // not something to broadcast twice.
  if (!row) return;
  broadcast(workspaceId, { type: "notification", actor_id: to.id, notification: row });
}

/**
 * Fan out for a newly written chat message.
 *
 * Called after the event is committed, never before: a notification pointing
 * at an event that failed to write is worse than a missing one.
 */
export async function notifyForEvent(e: {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  actor_id: string;
  kind: string;
  body: string | null;
  reply_to?: string | null;
  revision_of?: string | null;
}) {
  // Edits and deletes reuse the message kind through a revision chain. The
  // original already notified; re-notifying on every keystroke-batch of an
  // edit would be unbearable.
  if (e.revision_of) return;
  if (e.kind !== "message" && e.kind !== "agent_message") return;

  const author = await maybeOne<{ handle: string; kind: string; owner_actor_id: string | null }>(
    `select handle, kind, owner_actor_id from actors where id = $1`,
    [e.actor_id],
  );
  if (!author) return;

  const targets = new Map<string, Recipient>();
  const add = (r: Recipient) => {
    // Never notify someone about their own message, and never twice.
    if (r.id !== e.actor_id) targets.set(r.id, r);
  };

  /* -------------------------------- mentions ------------------------------- */
  const handles = mentionedHandles(e.body);
  let mentioned: Recipient[] = [];
  if (handles.length) {
    const rows = await q<{ id: string }>(
      `select id from actors
        where workspace_id = $1 and kind = 'human' and lower(handle) = any($2::text[])`,
      [e.workspace_id, handles],
    );
    mentioned = await eligible(e.workspace_id, e.channel_id, rows.map((r) => r.id), e.actor_id);
    for (const r of mentioned) {
      add(r);
      await insert(e.workspace_id, r, {
        kind: "mention",
        title: `${author.handle} mentioned you`,
        body: excerpt(e.body),
        channelId: e.channel_id,
        eventId: e.id,
        fromId: e.actor_id,
        fromHandle: author.handle,
      });
    }
  }

  /* --------------------------------- reply --------------------------------- */
  if (e.reply_to) {
    const parent = await maybeOne<{ actor_id: string }>(
      `select actor_id from events where id = $1`,
      [e.reply_to],
    );
    if (parent && parent.actor_id !== e.actor_id && !targets.has(parent.actor_id)) {
      const [r] = await eligible(e.workspace_id, e.channel_id, [parent.actor_id], e.actor_id);
      if (r) {
        add(r);
        await insert(e.workspace_id, r, {
          kind: "reply",
          title: `${author.handle} replied to you`,
          body: excerpt(e.body),
          channelId: e.channel_id,
          eventId: e.id,
          fromId: e.actor_id,
          fromHandle: author.handle,
        });
      }
    }
  }

  /* ------------------------------- agent post ------------------------------ */
  // An agent posting is the end of work its owner started somewhere they
  // cannot see. They get told even if they were not mentioned.
  if (author.kind === "agent" && author.owner_actor_id && !targets.has(author.owner_actor_id)) {
    const [owner] = await eligible(e.workspace_id, e.channel_id, [author.owner_actor_id], e.actor_id);
    if (owner) {
      await insert(e.workspace_id, owner, {
        kind: "agent",
        title: `${author.handle} posted`,
        body: excerpt(e.body),
        channelId: e.channel_id,
        eventId: e.id,
        fromId: e.actor_id,
        fromHandle: author.handle,
      });
    }
  }
}

/** Someone was given a task. */
export async function notifyTaskAssigned(t: {
  workspace_id: string;
  task_id: string;
  title: string;
  assignee_id: string | null;
  by_actor_id: string;
  channel_id: string | null;
}) {
  if (!t.assignee_id || t.assignee_id === t.by_actor_id) return;
  const [r] = await eligible(t.workspace_id, null, [t.assignee_id], t.by_actor_id);
  if (!r) return;
  const by = await maybeOne<{ handle: string }>(`select handle from actors where id = $1`, [
    t.by_actor_id,
  ]);
  await insert(t.workspace_id, r, {
    kind: "task",
    title: `${by?.handle ?? "Someone"} assigned you a task`,
    body: t.title,
    channelId: t.channel_id,
    fromId: t.by_actor_id,
    fromHandle: by?.handle ?? null,
  });
}

/* --------------------------------- reading -------------------------------- */

export async function listNotifications(
  actorId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return q<Notification>(
    `select id, kind, title, body, channel_id, event_id, from_handle, read_at, created_at
       from notifications
      where actor_id = $1 ${opts.unreadOnly ? "and read_at is null" : ""}
      order by created_at desc
      limit $2`,
    [actorId, limit],
  );
}

export async function unreadCount(actorId: string): Promise<number> {
  const r = await maybeOne<{ n: number }>(
    `select count(*)::int as n from notifications where actor_id = $1 and read_at is null`,
    [actorId],
  );
  return r?.n ?? 0;
}

export async function markRead(actorId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await q<{ id: string }>(
    `update notifications set read_at = now()
      where actor_id = $1 and id = any($2::uuid[]) and read_at is null
      returning id`,
    [actorId, ids],
  );
  return rows.length;
}

export async function markAllRead(actorId: string): Promise<number> {
  const rows = await q<{ id: string }>(
    `update notifications set read_at = now()
      where actor_id = $1 and read_at is null returning id`,
    [actorId],
  );
  return rows.length;
}

/* ------------------------------- unread counts ----------------------------- */

/**
 * Per-channel unread counts, from the read cursor rather than per-message rows.
 *
 * Counts only what a person could have read: an actor's own messages are never
 * unread to them, and archived channels do not nag.
 */
export async function channelUnread(workspaceId: string, actorId: string) {
  return q<{ channel_id: string; unread: number; mentions: number }>(
    `select c.id as channel_id,
            count(e.id)::int as unread,
            count(e.id) filter (
              where e.body ilike '%@' || (select handle from actors where id = $2) || '%'
            )::int as mentions
       from channels c
       left join channel_reads r on r.channel_id = c.id and r.actor_id = $2
       left join events e
              on e.channel_id = c.id
             and e.seq > coalesce(r.last_read_seq, 0)
             and e.actor_id <> $2
             and e.kind in ('message','agent_message')
             and e.revision_of is null
             -- A tombstoned message is not something to catch up on.
             and not coalesce((e.payload->>'deleted')::boolean, false)
      where c.workspace_id = $1 and c.status = 'open'
      group by c.id
     having count(e.id) > 0`,
    [workspaceId, actorId],
  );
}

/** Advance the cursor. Monotonic — reading history never un-reads the present. */
export async function markChannelRead(actorId: string, channelId: string, seq: number) {
  await q(
    `insert into channel_reads (actor_id, channel_id, last_read_seq)
     values ($1, $2, $3)
     on conflict (actor_id, channel_id)
       do update set last_read_seq = greatest(channel_reads.last_read_seq, excluded.last_read_seq),
                     updated_at = now()`,
    [actorId, channelId, seq],
  );
}
