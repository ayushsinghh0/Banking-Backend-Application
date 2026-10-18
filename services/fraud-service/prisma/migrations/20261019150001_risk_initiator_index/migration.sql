CREATE INDEX CONCURRENTLY IF NOT EXISTS "risk_assessments_initiated_by_assessed_at_idx" ON "risk_assessments"("initiated_by", "assessed_at");
