-- CreateTable
CREATE TABLE "kyc_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" "KycStatus",
    "to_status" "KycStatus",
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kyc_events_user_id_created_at_idx" ON "kyc_events"("user_id", "created_at");


-- ---------------------------------------------------------------------------
-- Append-only tables: rows can be inserted and read, never changed or removed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_kyc_events_append_only" BEFORE UPDATE OR DELETE ON "kyc_events" FOR EACH ROW EXECUTE FUNCTION "prevent_mutation"();
CREATE TRIGGER "trg_kyc_events_no_truncate" BEFORE TRUNCATE ON "kyc_events" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_mutation"();

-- Runtime role (customer_app) loses the privileges it must never need (no-op if the role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'customer_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "kyc_events" FROM customer_app;
  END IF;
END $$;
