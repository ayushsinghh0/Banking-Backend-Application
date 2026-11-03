-- Open-alert lookup per account (velocity alert deduplication), built without blocking alert writes
CREATE INDEX CONCURRENTLY IF NOT EXISTS "fraud_alerts_account_id_created_at_idx" ON "fraud_alerts"("account_id", "created_at");
