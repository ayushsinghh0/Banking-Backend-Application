-- DropIndex
DROP INDEX "outbox_events_aggregate_id_status_idx";

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_seq_idx" ON "outbox_events"("aggregate_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");


ALTER TABLE "bank_accounts" ADD CONSTRAINT "chk_bank_accounts_version" CHECK ("version" >= 1);
