-- DropIndex
DROP INDEX "outbox_events_aggregate_id_status_idx";

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "seq" BIGINT;
-- Existing (pending) events get their sequence in creation order, so per-aggregate publish order holds
CREATE SEQUENCE "outbox_events_seq_seq" OWNED BY "outbox_events"."seq";
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM "outbox_events")
UPDATE "outbox_events" o SET "seq" = ordered.n FROM ordered WHERE o.id = ordered.id;
SELECT setval('"outbox_events_seq_seq"', COALESCE((SELECT max("seq") FROM "outbox_events"), 0) + 1, false);
ALTER TABLE "outbox_events" ALTER COLUMN "seq" SET DEFAULT nextval('"outbox_events_seq_seq"'), ALTER COLUMN "seq" SET NOT NULL;

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_seq_idx" ON "outbox_events"("aggregate_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");


ALTER TABLE "bank_accounts" ADD CONSTRAINT "chk_bank_accounts_version" CHECK ("version" >= 1) NOT VALID;
ALTER TABLE "bank_accounts" VALIDATE CONSTRAINT "chk_bank_accounts_version";
