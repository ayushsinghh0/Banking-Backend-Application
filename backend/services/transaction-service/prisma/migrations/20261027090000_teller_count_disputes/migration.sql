-- Teller close-out disputes: the latest supervisor blind count that disagreed with the teller's declared
-- closing count, and who made it. A second, different administrator counting the same amount settles the
-- session on the supervisors' count. Nullable columns without defaults: catalog-only, no table rewrite.
ALTER TABLE "teller_sessions" ADD COLUMN     "disputed_count" BIGINT,
ADD COLUMN     "disputed_by" TEXT,
ADD COLUMN     "disputed_at" TIMESTAMP(3);

-- A recorded dispute is complete, non-negative and never made by the session's own teller.
-- NOT VALID here (no scan under the ACCESS EXCLUSIVE lock); validated in the next migration.
ALTER TABLE "teller_sessions" ADD CONSTRAINT "chk_teller_sessions_dispute" CHECK (
  ("disputed_count" IS NULL AND "disputed_by" IS NULL AND "disputed_at" IS NULL)
  OR ("disputed_count" >= 0 AND "disputed_by" IS NOT NULL AND "disputed_at" IS NOT NULL AND "disputed_by" <> "teller_id")
) NOT VALID;
