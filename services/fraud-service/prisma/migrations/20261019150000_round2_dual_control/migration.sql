-- DropIndex
DROP INDEX "outbox_events_aggregate_id_status_idx";

-- AlterTable
ALTER TABLE "fraud_alerts" ADD COLUMN     "cash_operation_id" TEXT,
ADD COLUMN     "close_requested_by" TEXT,
ADD COLUMN     "close_requested_status" "AlertStatus",
ADD COLUMN     "initiated_by" TEXT;

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "seq" BIGINT;
-- Existing (pending) events get their sequence in creation order, so per-aggregate publish order holds
CREATE SEQUENCE "outbox_events_seq_seq" OWNED BY "outbox_events"."seq";
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM "outbox_events")
UPDATE "outbox_events" o SET "seq" = ordered.n FROM ordered WHERE o.id = ordered.id;
SELECT setval('"outbox_events_seq_seq"', COALESCE((SELECT max("seq") FROM "outbox_events"), 0) + 1, false);
ALTER TABLE "outbox_events" ALTER COLUMN "seq" SET DEFAULT nextval('"outbox_events_seq_seq"'), ALTER COLUMN "seq" SET NOT NULL;

-- AlterTable
ALTER TABLE "risk_assessments" ADD COLUMN     "initiated_by" TEXT,
ADD COLUMN     "transaction_type" TEXT;

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_seq_idx" ON "outbox_events"("aggregate_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");



