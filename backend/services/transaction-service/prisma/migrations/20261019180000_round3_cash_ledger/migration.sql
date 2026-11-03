-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerAccountKind" ADD VALUE 'VAULT_CASH';
ALTER TYPE "LedgerAccountKind" ADD VALUE 'CASH_SUSPENSE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TellerSessionStatus" ADD VALUE 'ISSUED';
ALTER TYPE "TellerSessionStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'CASH_TRANSFER';

-- AlterTable
ALTER TABLE "teller_sessions" ADD COLUMN     "accepted_at" TIMESTAMP(3),
ADD COLUMN     "issued_by" TEXT;

-- CreateTable
CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);


-- Dual-control cash: the vault and suspense accounts are created on first use by the ledger service.
-- Sessions now start ISSUED (default set in the next migration: a new enum value can't be used in the
-- transaction that adds it).
