-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('CUSTOMER', 'TELLER_CASH');

-- CreateEnum
CREATE TYPE "TellerSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'RECONCILED');

-- DropIndex
DROP INDEX "outbox_events_aggregate_id_status_idx";

-- AlterTable
ALTER TABLE "ledger_accounts" ADD COLUMN     "control_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" "LedgerAccountKind" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "seq" BIGINT;
-- Existing (pending) events get their sequence in creation order, so per-aggregate publish order holds
CREATE SEQUENCE "outbox_events_seq_seq" OWNED BY "outbox_events"."seq";
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM "outbox_events")
UPDATE "outbox_events" o SET "seq" = ordered.n FROM ordered WHERE o.id = ordered.id;
SELECT setval('"outbox_events_seq_seq"', COALESCE((SELECT max("seq") FROM "outbox_events"), 0) + 1, false);
ALTER TABLE "outbox_events" ALTER COLUMN "seq" SET DEFAULT nextval('"outbox_events_seq_seq"'), ALTER COLUMN "seq" SET NOT NULL;

-- CreateTable
CREATE TABLE "teller_sessions" (
    "id" TEXT NOT NULL,
    "teller_id" TEXT NOT NULL,
    "business_date" TEXT NOT NULL,
    "drawer_account_id" TEXT NOT NULL,
    "opening_float" BIGINT NOT NULL,
    "status" "TellerSessionStatus" NOT NULL DEFAULT 'OPEN',
    "declared_closing" BIGINT,
    "expected_closing" BIGINT,
    "discrepancy" BIGINT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "signed_off_by" TEXT,
    "signed_off_at" TIMESTAMP(3),

    CONSTRAINT "teller_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_authorizations" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "cash_operation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beneficiaries" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "activates_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beneficiaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teller_sessions_status_business_date_idx" ON "teller_sessions"("status", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "teller_sessions_teller_id_business_date_key" ON "teller_sessions"("teller_id", "business_date");

-- CreateIndex
CREATE INDEX "withdrawal_authorizations_account_id_used_at_idx" ON "withdrawal_authorizations"("account_id", "used_at");

-- CreateIndex
CREATE INDEX "beneficiaries_customer_id_idx" ON "beneficiaries"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "beneficiaries_customer_id_account_id_key" ON "beneficiaries"("customer_id", "account_id");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_seq_idx" ON "outbox_events"("aggregate_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");


-- ---------------------------------------------------------------------------
-- Integrity constraints for teller drawers, withdrawal codes and beneficiaries
-- ---------------------------------------------------------------------------
-- Cash accounts (drawers, vault, suspense) are assets that may legitimately go negative (e.g. the vault
-- issuing floats for cash that predates the ledger); customer balances never may.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "chk_ledger_accounts_balance_non_negative";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "chk_ledger_accounts_balance_non_negative" CHECK ("balance" >= 0 OR "kind" <> 'CUSTOMER') NOT VALID;
ALTER TABLE "ledger_accounts" VALIDATE CONSTRAINT "chk_ledger_accounts_balance_non_negative";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "chk_ledger_accounts_balance_cap" CHECK ("balance" <= 900000000000000000 AND "balance" >= -900000000000000000) NOT VALID;
ALTER TABLE "ledger_accounts" VALIDATE CONSTRAINT "chk_ledger_accounts_balance_cap";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "chk_ledger_accounts_control_version" CHECK ("control_version" >= 0) NOT VALID;
ALTER TABLE "ledger_accounts" VALIDATE CONSTRAINT "chk_ledger_accounts_control_version";
-- Entry balances can be negative for drawers; customer-account balances are enforced on ledger_accounts
ALTER TABLE "ledger_entries" DROP CONSTRAINT "chk_ledger_entries_balance_after_non_negative";
ALTER TABLE "cash_operations" ADD CONSTRAINT "chk_cash_operations_amount_positive" CHECK ("amount" > 0) NOT VALID;
ALTER TABLE "cash_operations" VALIDATE CONSTRAINT "chk_cash_operations_amount_positive";
ALTER TABLE "withdrawal_authorizations" ADD CONSTRAINT "chk_withdrawal_authorizations_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "teller_sessions" ADD CONSTRAINT "chk_teller_sessions_opening_float" CHECK ("opening_float" >= 0);
-- One drawer per teller
CREATE UNIQUE INDEX "ledger_accounts_one_drawer_per_teller" ON "ledger_accounts"("customer_id") WHERE "kind" = 'TELLER_CASH';

-- Runtime role: no deleting or truncating control records. Fails loudly if the role model is missing,
-- so a database without the owner/app split can't silently run with an over-privileged service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    RAISE EXCEPTION 'Role ledger_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  REVOKE DELETE, TRUNCATE ON "teller_sessions", "withdrawal_authorizations" FROM ledger_app;
  REVOKE DELETE, TRUNCATE ON "beneficiaries" FROM ledger_app;
END $$;
