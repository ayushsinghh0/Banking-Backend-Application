-- CreateEnum
CREATE TYPE "CashOperationType" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "CashOperationStatus" AS ENUM ('PENDING_APPROVAL', 'EXECUTED', 'REJECTED');

-- AlterTable
ALTER TABLE "ledger_accounts" ADD COLUMN     "closed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "cash_operations" (
    "id" TEXT NOT NULL,
    "type" "CashOperationType" NOT NULL,
    "status" "CashOperationStatus" NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "description" TEXT,
    "requested_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "transaction_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_operations_transaction_id_key" ON "cash_operations"("transaction_id");

-- CreateIndex
CREATE INDEX "cash_operations_status_created_at_idx" ON "cash_operations"("status", "created_at");

-- CreateIndex
CREATE INDEX "cash_operations_requested_by_created_at_idx" ON "cash_operations"("requested_by", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

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
CREATE TRIGGER "trg_transactions_append_only" BEFORE UPDATE OR DELETE ON "transactions" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_transactions_no_truncate" BEFORE TRUNCATE ON "transactions" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- ledger_entries already rejects UPDATE/DELETE (init migration); also block TRUNCATE
CREATE TRIGGER "trg_ledger_entries_no_truncate" BEFORE TRUNCATE ON "ledger_entries" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- Runtime role (ledger_app) loses the privileges it must never need (no-op if the role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_entries", "transactions", "audit_log" FROM ledger_app;
    REVOKE DELETE, TRUNCATE ON "ledger_accounts", "cash_operations" FROM ledger_app;
  END IF;
END $$;
