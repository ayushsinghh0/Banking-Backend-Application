-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "family_expires_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
ADD COLUMN     "mfa_authenticated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfa_last_used_step" INTEGER,
ADD COLUMN     "mfa_pending_secret_enc" TEXT,
ADD COLUMN     "mfa_secret_enc" TEXT;

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_target_id_created_at_idx" ON "audit_log"("target_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_idx" ON "outbox_events"("aggregate_id", "status");


-- Existing sessions got a 30-day absolute expiry above; new rows must set it explicitly
ALTER TABLE "refresh_tokens" ALTER COLUMN "family_expires_at" DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- Append-only tables: rows can be inserted and read, never changed or removed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- Runtime role (auth_app) loses the privileges it must never need (no-op if the role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM auth_app;
  END IF;
END $$;
