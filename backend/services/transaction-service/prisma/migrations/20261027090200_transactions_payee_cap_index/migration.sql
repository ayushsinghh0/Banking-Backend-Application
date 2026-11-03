-- New-beneficiary cap: what a customer sent to one destination over the last 24 hours. Built without
-- blocking payments; CONCURRENTLY can't run in a transaction, so this migration holds this single statement.
-- (The name is exactly 63 bytes, Postgres' identifier limit, and matches Prisma's default.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_initiated_by_destination_account_id_created_at_idx" ON "transactions"("initiated_by", "destination_account_id", "created_at");
