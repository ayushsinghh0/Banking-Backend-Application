-- Rules that raised each alert (velocity alerts are deduplicated per account). A constant default is a
-- catalog-only change on PostgreSQL 11+ (no table rewrite); existing alerts read as an empty list.
ALTER TABLE "fraud_alerts" ADD COLUMN "rule_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
