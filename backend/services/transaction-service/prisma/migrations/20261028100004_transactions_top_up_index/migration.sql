-- Refund cap: what has been refunded (and reversed) for one top-up. Partial, so the index only holds top-up
-- postings. Built without blocking payments; CONCURRENTLY can't run in a transaction, so this migration holds
-- this single statement only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_top_up_id_idx" ON "transactions"("top_up_id") WHERE "top_up_id" IS NOT NULL;
