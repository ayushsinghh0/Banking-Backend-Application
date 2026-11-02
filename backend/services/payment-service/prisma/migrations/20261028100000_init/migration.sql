-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'CAPTURED', 'CREDITED', 'CREDIT_BLOCKED', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "account_number_last4" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "method" TEXT,
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "captured_amount_paise" BIGINT,
    "captured_currency" TEXT,
    "failure_reason" TEXT,
    "ledger_transaction_id" TEXT,
    "refund_id" TEXT,
    "refund_reason" TEXT,
    "refund_requested_by" TEXT,
    "refund_request_key" TEXT,
    "refund_requested_at" TIMESTAMP(3),
    "refund_ledger_transaction_id" TEXT,
    "provider_refund_id" TEXT,
    "refund_failure_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3),
    "credited_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "reconciled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_status_history" (
    "id" TEXT NOT NULL,
    "top_up_id" TEXT NOT NULL,
    "from_status" "PaymentStatus",
    "to_status" "PaymentStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "actor_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "locked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_order_id_key" ON "payment_orders"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_payment_id_key" ON "payment_orders"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_refund_id_key" ON "payment_orders"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_refund_id_key" ON "payment_orders"("provider_refund_id");

-- CreateIndex
CREATE INDEX "payment_orders_customer_id_created_at_id_idx" ON "payment_orders"("customer_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payment_orders_status_created_at_idx" ON "payment_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_orders_status_updated_at_idx" ON "payment_orders"("status", "updated_at");

-- CreateIndex
CREATE INDEX "payment_orders_created_at_idx" ON "payment_orders"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_customer_id_idempotency_key_key" ON "payment_orders"("customer_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payment_status_history_top_up_id_created_at_idx" ON "payment_status_history"("top_up_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_created_at_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_seq_idx" ON "outbox_events"("aggregate_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_action_target_id_created_at_idx" ON "audit_log"("action", "target_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_seq_key" ON "audit_log"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_hash_key" ON "audit_log"("hash");

-- AddForeignKey
ALTER TABLE "payment_status_history" ADD CONSTRAINT "payment_status_history_top_up_id_fkey" FOREIGN KEY ("top_up_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity rules the application also enforces (last line of defence)
-- ---------------------------------------------------------------------------
ALTER TABLE "payment_orders" ADD CONSTRAINT "chk_payment_orders_amount_positive" CHECK ("amount_paise" > 0 AND "amount_paise" <= 900000000000000000);
ALTER TABLE "payment_orders" ADD CONSTRAINT "chk_payment_orders_currency" CHECK ("currency" = 'INR');
ALTER TABLE "payment_orders" ADD CONSTRAINT "chk_payment_orders_version" CHECK ("version" >= 0);
ALTER TABLE "payment_orders" ADD CONSTRAINT "chk_payment_orders_captured_amount" CHECK ("captured_amount_paise" IS NULL OR "captured_amount_paise" >= 0);
-- A credited top-up always names the ledger posting that credited it
ALTER TABLE "payment_orders" ADD CONSTRAINT "chk_payment_orders_credited_has_posting" CHECK ("status" <> 'CREDITED' OR "ledger_transaction_id" IS NOT NULL);
ALTER TABLE "payment_orders" ADD CONSTRAINT "chk_payment_orders_refund_has_id" CHECK ("status" NOT IN ('REFUND_PENDING', 'REFUNDED') OR "refund_id" IS NOT NULL);
ALTER TABLE "payment_orders" ADD CONSTRAINT "chk_payment_orders_reason_length" CHECK ("refund_reason" IS NULL OR char_length("refund_reason") BETWEEN 10 AND 300);
ALTER TABLE "audit_log" ADD CONSTRAINT "chk_audit_log_hashes" CHECK ("hash" ~ '^[0-9a-f]{64}$' AND "prev_hash" ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Append-only tables: rows can be inserted and read, never changed or removed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_status_history_append_only" BEFORE UPDATE OR DELETE ON "payment_status_history" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_payment_status_history_no_truncate" BEFORE TRUNCATE ON "payment_status_history" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();
-- Orders and the webhook inbox are updated in place but never removed
CREATE TRIGGER "trg_payment_orders_no_truncate" BEFORE TRUNCATE ON "payment_orders" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_webhook_events_no_truncate" BEFORE TRUNCATE ON "webhook_events" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- ---------------------------------------------------------------------------
-- Runtime role (payment_app) loses the privileges it must never need. Fails loudly if the role model is
-- missing, so a database without the owner/app split can't silently run an over-privileged service.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_app') THEN
    RAISE EXCEPTION 'Role payment_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON "payment_status_history", "audit_log" FROM payment_app;
  REVOKE DELETE, TRUNCATE ON "payment_orders", "webhook_events" FROM payment_app;
  REVOKE TRUNCATE ON "outbox_events", "job_leases" FROM payment_app;
END $$;
