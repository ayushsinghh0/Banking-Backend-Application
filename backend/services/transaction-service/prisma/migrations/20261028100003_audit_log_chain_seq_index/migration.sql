-- Chain order: seq is unique among chained rows, and the chain head (highest seq) is one index probe for
-- every audit write. Partial, so the pre-chain rows (NULL seq) are not in it and never scanned for the head.
-- Built without blocking audit writes; CONCURRENTLY can't run in a transaction, so this migration holds this
-- single statement only.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_chain_seq_key" ON "audit_log"("seq") WHERE "hash" IS NOT NULL;
