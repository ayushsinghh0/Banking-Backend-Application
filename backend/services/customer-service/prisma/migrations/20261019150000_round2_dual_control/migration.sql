-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "staff_access_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_access_log_user_id_created_at_idx" ON "staff_access_log"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "staff_access_log_actor_id_created_at_idx" ON "staff_access_log"("actor_id", "created_at");


-- Staff access to customer PII is append-only evidence
CREATE TRIGGER "trg_staff_access_log_append_only" BEFORE UPDATE OR DELETE ON "staff_access_log" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_staff_access_log_no_truncate" BEFORE TRUNCATE ON "staff_access_log" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();
ALTER TABLE "customer_profiles" ADD CONSTRAINT "chk_customer_profiles_version" CHECK ("version" >= 1) NOT VALID;
ALTER TABLE "customer_profiles" VALIDATE CONSTRAINT "chk_customer_profiles_version";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'customer_app') THEN
    RAISE EXCEPTION 'Role customer_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON "staff_access_log" FROM customer_app;
END $$;
