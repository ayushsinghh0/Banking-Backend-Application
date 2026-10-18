-- DropIndex
DROP INDEX "outbox_events_aggregate_id_status_idx";

-- AlterTable
ALTER TABLE "fraud_alerts" ADD COLUMN     "cash_operation_id" TEXT,
ADD COLUMN     "close_requested_by" TEXT,
ADD COLUMN     "close_requested_status" "AlertStatus",
ADD COLUMN     "initiated_by" TEXT;

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- AlterTable
ALTER TABLE "risk_assessments" ADD COLUMN     "initiated_by" TEXT,
ADD COLUMN     "transaction_type" TEXT;

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_seq_idx" ON "outbox_events"("aggregate_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");

-- CreateIndex
CREATE INDEX "risk_assessments_initiated_by_assessed_at_idx" ON "risk_assessments"("initiated_by", "assessed_at");

