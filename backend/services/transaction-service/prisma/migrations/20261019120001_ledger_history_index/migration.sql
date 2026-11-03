-- Built without blocking ledger writes (a plain CREATE INDEX would stop all payments while it builds)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ledger_entries_account_id_created_at_id_idx" ON "ledger_entries"("account_id", "created_at", "id");
