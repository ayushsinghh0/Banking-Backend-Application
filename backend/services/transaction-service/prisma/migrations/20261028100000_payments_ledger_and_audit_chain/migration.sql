-- Online top-ups (Razorpay through payment-service) and the tamper-evident audit chain.
-- Enum values can be added inside a transaction but not used in it: the PAYMENT_CLEARING account and the
-- constraints that name the new transaction types are in the next migration.

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'ONLINE_TOP_UP';
ALTER TYPE "TransactionType" ADD VALUE 'TOP_UP_REFUND';

-- AlterEnum
ALTER TYPE "LedgerAccountKind" ADD VALUE 'PAYMENT_CLEARING';

-- AlterTable: nullable columns without defaults are catalog-only (no rewrite of the append-only tables)
ALTER TABLE "transactions" ADD COLUMN     "external_reference" TEXT,
ADD COLUMN     "top_up_id" TEXT;

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prev_hash" TEXT,
ADD COLUMN     "seq" BIGINT;

-- A row is either outside the chain (written before it existed: all three NULL) or a complete link.
-- NOT VALID: no scan under the ACCESS EXCLUSIVE lock; validated in a later migration.
ALTER TABLE "audit_log" ADD CONSTRAINT "chk_audit_log_chain_link" CHECK (
  ("seq" IS NULL AND "prev_hash" IS NULL AND "hash" IS NULL)
  OR ("seq" > 0 AND "prev_hash" ~ '^[0-9a-f]{64}$' AND "hash" ~ '^[0-9a-f]{64}$')
) NOT VALID;

-- The runtime role keeps exactly the privileges it had: append-only tables stay insert-and-read
-- (re-asserted here because these tables gained columns). Fails loudly without the owner/app role split.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    RAISE EXCEPTION 'Role ledger_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_entries", "transactions", "audit_log" FROM ledger_app;
  REVOKE DELETE, TRUNCATE ON "ledger_accounts" FROM ledger_app;
END $$;
