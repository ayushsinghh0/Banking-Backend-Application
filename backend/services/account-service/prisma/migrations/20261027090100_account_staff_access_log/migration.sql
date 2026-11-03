-- CreateTable
CREATE TABLE "account_staff_access_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "account_id" TEXT,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_staff_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_staff_access_log_customer_id_created_at_idx" ON "account_staff_access_log"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "account_staff_access_log_actor_id_created_at_idx" ON "account_staff_access_log"("actor_id", "created_at");


-- Staff reads of customer accounts are append-only evidence (prevent_mutation() comes from round1_security_hardening)
CREATE TRIGGER "trg_account_staff_access_log_append_only" BEFORE UPDATE OR DELETE ON "account_staff_access_log" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_account_staff_access_log_no_truncate" BEFORE TRUNCATE ON "account_staff_access_log" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- Runtime role: insert and read only. Fails loudly if the role model is missing, so a database without the
-- owner/app split can't silently run with an over-privileged service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'account_app') THEN
    RAISE EXCEPTION 'Role account_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  GRANT SELECT, INSERT ON "account_staff_access_log" TO account_app;
  REVOKE UPDATE, DELETE, TRUNCATE ON "account_staff_access_log" FROM account_app;
END $$;
