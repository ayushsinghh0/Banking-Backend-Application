-- Velocity and per-account structuring windows (account_id = ? AND assessed_at BETWEEN ? AND ?), built without blocking fraud evaluation
CREATE INDEX CONCURRENTLY IF NOT EXISTS "risk_assessments_account_id_assessed_at_idx" ON "risk_assessments"("account_id", "assessed_at");
