-- Validation scans under SHARE UPDATE EXCLUSIVE only, so postings and audit writes continue meanwhile.
-- Existing rows all satisfy both (no chain columns yet, no top-up postings yet).
ALTER TABLE "audit_log" VALIDATE CONSTRAINT "chk_audit_log_chain_link";
ALTER TABLE "transactions" VALIDATE CONSTRAINT "chk_transactions_top_up_link";
