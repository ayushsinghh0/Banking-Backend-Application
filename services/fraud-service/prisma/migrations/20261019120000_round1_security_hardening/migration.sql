-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- AlterTable
ALTER TABLE "fraud_alerts" ADD COLUMN     "reviewed_by" TEXT;

-- AlterTable
ALTER TABLE "risk_assessments" ADD COLUMN     "direction" TEXT NOT NULL DEFAULT 'OUTBOUND';

-- CreateTable
CREATE TABLE "fraud_alert_events" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "from_status" "AlertStatus" NOT NULL,
    "to_status" "AlertStatus" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fraud_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fraud_alert_events_alert_id_created_at_idx" ON "fraud_alert_events"("alert_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_created_at_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_idx" ON "outbox_events"("aggregate_id", "status");


-- ---------------------------------------------------------------------------
-- Append-only tables: rows can be inserted and read, never changed or removed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_fraud_alert_events_append_only" BEFORE UPDATE OR DELETE ON "fraud_alert_events" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_fraud_alert_events_no_truncate" BEFORE TRUNCATE ON "fraud_alert_events" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_risk_assessments_append_only" BEFORE UPDATE OR DELETE ON "risk_assessments" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_risk_assessments_no_truncate" BEFORE TRUNCATE ON "risk_assessments" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- Runtime role (fraud_app) loses the privileges it must never need (no-op if the role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fraud_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "fraud_alert_events", "risk_assessments" FROM fraud_app;
  END IF;
END $$;
