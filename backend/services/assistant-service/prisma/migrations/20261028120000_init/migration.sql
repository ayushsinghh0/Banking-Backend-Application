-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "AssistantProvider" AS ENUM ('llm', 'builtin');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('complete', 'interrupted', 'failed');

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "cards" JSONB NOT NULL DEFAULT '[]',
    "tool_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "provider" "AssistantProvider",
    "model" VARCHAR(100),
    "latency_ms" INTEGER,
    "status" "MessageStatus" NOT NULL DEFAULT 'complete',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "conversations_owner_id_updated_at_idx" ON "conversations"("owner_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_updated_at_idx" ON "conversations"("updated_at");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity rules the application also enforces: bounded text and non-negative accounting values
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_title_not_blank" CHECK ("title" IS NULL OR char_length(btrim("title")) > 0);
ALTER TABLE "messages" ADD CONSTRAINT "messages_content_length" CHECK (char_length("content") <= 20000);
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_content_length" CHECK ("role" <> 'user' OR char_length("content") BETWEEN 1 AND 2000);
ALTER TABLE "messages" ADD CONSTRAINT "messages_tokens_non_negative" CHECK ("prompt_tokens" >= 0 AND "completion_tokens" >= 0);
ALTER TABLE "messages" ADD CONSTRAINT "messages_latency_non_negative" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0);

-- Runtime role: row-level DML only. Messages are written once and never edited (they go with their conversation, by
-- the owner or the retention job), and nothing may be truncated. Fails loudly if the role model is missing, so a
-- database without the owner/app split can't silently run with an over-privileged service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_app') THEN
    RAISE EXCEPTION 'Role assistant_app does not exist: provision roles with docker/postgres/init-schemas.sh first';
  END IF;
  GRANT SELECT, INSERT, UPDATE, DELETE ON "conversations", "job_leases" TO assistant_app;
  GRANT SELECT, INSERT, DELETE ON "messages" TO assistant_app;
  REVOKE UPDATE ON "messages" FROM assistant_app;
  REVOKE TRUNCATE ON "conversations", "messages", "job_leases" FROM assistant_app;
END $$;
