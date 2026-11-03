-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_event_id_recipient_key" ON "notification_deliveries"("event_id", "recipient");


-- Runtime role (notification_app) loses the privileges it must never need (no-op if the role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notification_app') THEN
    REVOKE UPDATE, TRUNCATE ON "notification_deliveries" FROM notification_app;
  END IF;
END $$;
