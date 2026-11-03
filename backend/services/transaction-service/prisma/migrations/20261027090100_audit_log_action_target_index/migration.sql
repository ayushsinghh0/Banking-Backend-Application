-- Failure counters (wrong withdrawal codes per account, beneficiary add attempts) count audit rows by
-- action and target since a point in time. Built without blocking audit writes; CONCURRENTLY can't run in
-- a transaction, so this migration holds this single statement only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_action_target_id_created_at_idx" ON "audit_log"("action", "target_id", "created_at");
