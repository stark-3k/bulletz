-- Threads become channels, and "thread" is reclaimed for what the word
-- normally means in chat: a reply thread hanging off one message.
--
-- A channel is a durable room. A thread is a branch of conversation inside it,
-- rooted at a single message. events.reply_to names that root: null means the
-- message sits at the top level of its channel.

alter table threads rename to channels;
alter index if exists threads_ws_recent_idx rename to channels_ws_recent_idx;
alter index if exists threads_ws_status_idx rename to channels_ws_status_idx;

alter table events  rename column thread_id to channel_id;
alter table decisions rename column thread_id to channel_id;
alter table tasks     rename column thread_id to channel_id;
alter table rollups   rename column thread_id to channel_id;

alter index if exists events_thread_seq_idx rename to events_channel_seq_idx;

-- The reply thread. Self-referencing: a reply points at the message it hangs
-- off. Replies are never roots of other replies — one level, like every chat
-- app that has tried deeper and regretted it.
alter table events add column if not exists reply_to uuid references events(id) on delete cascade;
create index if not exists events_reply_to_idx on events (reply_to, seq);
