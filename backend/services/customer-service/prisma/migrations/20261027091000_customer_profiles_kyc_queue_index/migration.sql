-- Staff search / KYC review queue (?kycStatus=PENDING, oldest first). Built without blocking profile writes;
-- CONCURRENTLY must be the only statement of its migration (it cannot run inside a transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customer_profiles_kyc_status_created_at_idx" ON "customer_profiles"("kyc_status", "created_at");
