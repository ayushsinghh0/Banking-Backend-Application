-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "bank_limit_ceiling" BIGINT;


-- Nullable without a default: a catalog-only change, no table rewrite. Existing accounts get no ceiling
-- (owners stay bounded by the customer cap, as before).
ALTER TABLE "bank_accounts" ADD CONSTRAINT "chk_bank_accounts_bank_limit_ceiling_positive" CHECK ("bank_limit_ceiling" IS NULL OR "bank_limit_ceiling" > 0) NOT VALID;
ALTER TABLE "bank_accounts" VALIDATE CONSTRAINT "chk_bank_accounts_bank_limit_ceiling_positive";
