-- Staff search without a status filter (newest first). Built without blocking profile writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customer_profiles_created_at_idx" ON "customer_profiles"("created_at");
