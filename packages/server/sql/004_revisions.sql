-- Message edits and deletions, without breaking append-only.
--
-- An edit appends a NEW event carrying the new body and pointing at the one it
-- replaces. A deletion appends a tombstone the same way. No existing row is
-- ever updated or removed, so the full history of what was said — and what the
-- agent read at the time — stays reconstructible.
--
-- The "current" message is the HEAD of a revision chain: the event that nothing
-- else points at.
alter table events add column if not exists revision_of uuid references events(id) on delete cascade;
create index if not exists events_revision_of_idx on events (revision_of);

-- NOTE: a tombstone hides content from every read path, but the original row
-- still holds the text. That is deliberate (audit), and it is NOT erasure —
-- a real redaction path would overwrite the body and is a separate feature.
