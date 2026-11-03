-- Staff user directory (GET /admin/users) lists users newest first. Built without blocking sign-ups, logins and
-- token rotation on "users" (a plain CREATE INDEX would); CONCURRENTLY must be the only statement in the file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_created_at_idx" ON "users"("created_at");
