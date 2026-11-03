-- Validation scans the table under SHARE UPDATE EXCLUSIVE only, so teller sessions stay writable meanwhile
ALTER TABLE "teller_sessions" VALIDATE CONSTRAINT "chk_teller_sessions_dispute";
