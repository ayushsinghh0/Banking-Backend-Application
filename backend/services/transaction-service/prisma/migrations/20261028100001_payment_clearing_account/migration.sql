-- The PAYMENT_CLEARING system account (an asset: money receivable from the payment provider). A captured
-- top-up debits it and credits the customer; a refund does the reverse. Created here so it exists before
-- the first top-up; transaction-service also ensures it at startup (idempotent, same account number).
INSERT INTO "ledger_accounts" ("id", "kind", "account_number", "customer_id", "currency", "balance", "daily_limit", "is_active", "control_version", "created_at", "updated_at")
VALUES (gen_random_uuid()::text, 'PAYMENT_CLEARING', 'PAYMENT-CLEARING', 'BANK', 'INR', 0, 900000000000000000, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("account_number") DO NOTHING;

-- Every top-up posting names its top-up: refunds are capped by what that top-up credited, which the ledger
-- checks by summing on top_up_id. NOT VALID here (no scan under the lock); validated in the next migration.
ALTER TABLE "transactions" ADD CONSTRAINT "chk_transactions_top_up_link" CHECK (
  "type" NOT IN ('ONLINE_TOP_UP', 'TOP_UP_REFUND') OR "top_up_id" IS NOT NULL
) NOT VALID;
