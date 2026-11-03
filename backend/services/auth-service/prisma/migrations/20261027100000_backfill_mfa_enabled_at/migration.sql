-- Round 3 added "mfa_enabled_at" without a backfill. Users who enabled MFA before it never get "mfaSince" in
-- their access tokens, so step-up (large transfers, instant payees, large withdrawal codes) can never succeed
-- for them. Backfill it for every enrolled user that still lacks it.
--
-- Value: "updated_at", not "created_at". The real enrolment time is unknown but lies between the two
-- (enabling MFA updates the row, so updated_at is never earlier than it). Step-up requires the factor to be
-- at least MFA_FACTOR_MIN_AGE_HOURS old, so the safe estimate is the latest possible one: it can only make a
-- factor look younger than it is (a user active in the last day may wait up to that long before step-up
-- works), never older, so no factor can skip the waiting period because of this backfill.
--
-- Plain SQL leaves "updated_at" itself unchanged. Only rows still NULL are touched, so re-running is a no-op,
-- and the set is bounded by the users who enrolled before round 3: one short UPDATE, no table rewrite.
UPDATE "users"
SET "mfa_enabled_at" = "updated_at"
WHERE "mfa_enabled" = true AND "mfa_enabled_at" IS NULL;
