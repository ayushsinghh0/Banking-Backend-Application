-- The audit chain's head ("SELECT hash ... WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1", taken on every
-- audited write) and the verification walk read only chained rows, in seq order. A partial index over exactly
-- those rows serves both without touching the legacy rows (seq NULL), and its uniqueness backs the sequence.
-- Built without blocking audited writes; CONCURRENTLY must be the only statement in the file.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_chain_seq_key" ON "audit_log"("seq") WHERE "hash" IS NOT NULL;
