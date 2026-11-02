-- Account security (design section 9) and the tamper-evident audit chain (section 12).
-- DDL generated with `prisma migrate diff` from the previous schema, then edited by hand where noted.

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('SIGN_IN_SUCCEEDED', 'SIGN_IN_FAILED', 'MFA_FAILED', 'NEW_DEVICE', 'SESSION_REVOKED', 'PASSWORD_CHANGED', 'IP_AUTO_BANNED');

-- CreateEnum
CREATE TYPE "IpRuleAction" AS ENUM ('DENY');

-- AlterTable (metadata only: no default, no rewrite). NULL until the user's first session after this release,
-- so existing users are never told about a "new device" on their first sign-in after the upgrade
ALTER TABLE "users" ADD COLUMN     "first_sign_in_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Audit chain. Hand-edited: the columns are added WITHOUT a default first, so existing rows keep seq, prev_hash
-- and hash NULL (they stay outside the chain, and the table is not rewritten); only new rows draw from the
-- sequence. Chain order is seq order: rows are appended under a transaction-scoped advisory lock.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_log" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prev_hash" TEXT,
ADD COLUMN     "seq" BIGINT;
CREATE SEQUENCE "audit_log_seq_seq" OWNED BY "audit_log"."seq";
ALTER TABLE "audit_log" ALTER COLUMN "seq" SET DEFAULT nextval('"audit_log_seq_seq"');
-- A chained row has all three; a legacy row has neither link nor hash
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chain_complete" CHECK (
  ("hash" IS NULL AND "prev_hash" IS NULL)
  OR ("hash" ~ '^[0-9a-f]{64}$' AND "prev_hash" ~ '^[0-9a-f]{64}$' AND "seq" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "first_ip" TEXT,
    "last_ip" TEXT,
    "user_agent" TEXT,
    "device_label" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "network" TEXT,
    "mfa" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" "SecurityEventType" NOT NULL,
    "ip" TEXT,
    "device_label" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_rules" (
    "id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "action" "IpRuleAction" NOT NULL DEFAULT 'DENY',
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "removed_by" TEXT,

    CONSTRAINT "ip_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "user_sessions_user_id_last_seen_at_idx" ON "user_sessions"("user_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "security_events_type_created_at_idx" ON "security_events"("type", "created_at");

-- CreateIndex
CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at");

-- CreateIndex
CREATE INDEX "ip_rules_removed_at_expires_at_idx" ON "ip_rules"("removed_at", "expires_at");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- security_events is append-only, except that rows past the 180-day retention may be deleted (the purge job).
-- The trigger enforces it for every role, so even a compromised auth_app can't erase recent history.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "security_events_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."created_at" < (now() AT TIME ZONE 'UTC') - interval '180 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: security events are append-only (only rows older than 180 days may be purged)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_security_events_append_only" BEFORE UPDATE OR DELETE ON "security_events" FOR EACH ROW EXECUTE FUNCTION "security_events_guard"();
CREATE TRIGGER "trg_security_events_no_truncate" BEFORE TRUNCATE ON "security_events" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- audit_log keeps its append-only triggers from round 1 (UPDATE, DELETE and TRUNCATE are refused)

-- Runtime role (auth_app): no rewriting of history, no hard deletes of IP rules (removal is a soft delete).
-- It keeps DELETE on security_events for the retention purge, which the trigger above bounds.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_app') THEN
    RAISE EXCEPTION 'Role auth_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  REVOKE UPDATE, TRUNCATE ON "security_events" FROM auth_app;
  REVOKE DELETE, TRUNCATE ON "ip_rules" FROM auth_app;
  REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM auth_app;
END $$;
