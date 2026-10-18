-- Additional Financial Integrity Constraints & Invariants

-- 1. Ensure account balance is never negative (overdraft prevention at DB level)
ALTER TABLE "ledger_accounts" 
ADD CONSTRAINT "chk_ledger_accounts_balance_non_negative" 
CHECK ("balance" >= 0);

-- 2. Ensure ledger entries always have strictly positive amounts
ALTER TABLE "ledger_entries" 
ADD CONSTRAINT "chk_ledger_entries_amount_positive" 
CHECK ("amount" > 0);

-- 3. Ensure transaction amount is strictly positive
ALTER TABLE "transactions" 
ADD CONSTRAINT "chk_transactions_amount_positive" 
CHECK ("amount" > 0);
