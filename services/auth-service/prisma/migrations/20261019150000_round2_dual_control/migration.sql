-- CreateEnum
CREATE TYPE "AdminRequestType" AS ENUM ('CREATE_STAFF', 'SET_USER_ACTIVE', 'RESET_MFA');

-- CreateEnum
CREATE TYPE "AdminRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EnrolmentPurpose" AS ENUM ('ACTIVATE', 'MFA_ENROL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'TELLER';
ALTER TYPE "Role" ADD VALUE 'KYC_OFFICER';
ALTER TYPE "Role" ADD VALUE 'FRAUD_ANALYST';

-- DropIndex
DROP INDEX "outbox_events_aggregate_id_status_idx";

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "seq" BIGINT;
-- Existing (pending) events get their sequence in creation order, so per-aggregate publish order holds
CREATE SEQUENCE "outbox_events_seq_seq" OWNED BY "outbox_events"."seq";
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM "outbox_events")
UPDATE "outbox_events" o SET "seq" = ordered.n FROM ordered WHERE o.id = ordered.id;
SELECT setval('"outbox_events_seq_seq"', COALESCE((SELECT max("seq") FROM "outbox_events"), 0) + 1, false);
ALTER TABLE "outbox_events" ALTER COLUMN "seq" SET DEFAULT nextval('"outbox_events_seq_seq"'), ALTER COLUMN "seq" SET NOT NULL;

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "rotated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "created_by" TEXT;

-- CreateTable
CREATE TABLE "enrolment_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" "EnrolmentPurpose" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrolment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_requests" (
    "id" TEXT NOT NULL,
    "type" "AdminRequestType" NOT NULL,
    "status" "AdminRequestStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "target_user_id" TEXT,
    "requested_by" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enrolment_tokens_token_hash_key" ON "enrolment_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "enrolment_tokens_user_id_purpose_idx" ON "enrolment_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "admin_requests_status_created_at_idx" ON "admin_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_seq_idx" ON "outbox_events"("aggregate_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");

-- AddForeignKey
ALTER TABLE "enrolment_tokens" ADD CONSTRAINT "enrolment_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Approval requests are decided once and kept as evidence: no deletes
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_app') THEN
    RAISE EXCEPTION 'Role auth_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  REVOKE DELETE, TRUNCATE ON "admin_requests" FROM auth_app;
END $$;
