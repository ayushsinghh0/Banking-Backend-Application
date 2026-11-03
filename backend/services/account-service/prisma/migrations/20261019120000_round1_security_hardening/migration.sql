-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_target_id_created_at_idx" ON "audit_log"("target_id", "created_at");

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
CREATE TRIGGER "trg_audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- Runtime role (account_app) loses the privileges it must never need (no-op if the role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'account_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM account_app;
    REVOKE DELETE, TRUNCATE ON "bank_accounts" FROM account_app;
  END IF;
END $$;
