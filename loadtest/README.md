# Load tests

k6 scenarios for BankSphere and the seed that prepares their users. They measure what one replica of each tier
sustains within its SLO; [docs/operations/capacity-plan.md](../docs/operations/capacity-plan.md) turns those
numbers into replica counts for the target population.

| Path | What it is |
|---|---|
| `seed.mjs` | Creates N verified, KYC-approved customers with a SAVINGS and a CURRENT account and a funded balance, through the public API and Mailpit. Idempotent. |
| `k6/browse.js` | Dashboard reads: accounts, every balance in parallel, recent history, profile and identity now and then. |
| `k6/transfers.js` | Own-account transfers with an `Idempotency-Key` per attempt, a same-key retry when the outcome is unknown, and deliberate replays that must return the original transfer. |
| `k6/topups.js` | Add money through the Razorpay **simulator**: config, order, simulated checkout, confirm. Aborts unless the stack reports `mode: simulator`. |
| `k6/assistant.js` | Sphere questions over SSE; checks the event stream and records time to first byte. |
| `k6/realtime.js` | Holds N concurrent real-time SSE streams through nginx and the gateway. |
| `k6/mixed.js` | Every journey at once at rates derived from one target request rate, plus open streams. The run behind the capacity plan. |
| `k6/lib/` | Shared configuration, sessions (sign in once per VU, refresh before expiry), tagged requests, SSE parsing, load profiles and thresholds. |
| `k6/fixtures/users.example.json` | A fake users file, only so `k6 inspect` can load the scripts without a seeded stack. |

`.data/` (seeded users, staff authenticator secrets; files are written with mode 0600, on Windows the folder ACL applies) and
`results/` are git-ignored and never committed.

## Safety

- **Never run these against production.** They create customers, staff, cash deposits and payments. The seed
  refuses a non-local `BASE_URL` unless `SEED_ALLOW_REMOTE=true`, and it needs Mailpit, which production does
  not have. `topups.js` aborts unless payments are in simulator mode.
- Every profile defaults to `smoke`, which is a few requests per second. Heavier profiles are opt-in.
- Run load against a stack sized for it. The local Compose stack on a 4 GB WSL VM saturates on CPU long before
  any production-shaped number; use it to prove the scripts, and a staging cluster to measure.

## Prerequisites

- The stack with the development overlay (Mailpit captures the verification and activation emails):
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`.
- Two bootstrap administrators with authenticators enrolled. Staff administration is four-eyes, so the seed
  needs both: `cd frontend && node e2e/bootstrap.mjs` and the browser journeys enrol them and record them in
  `frontend/e2e/.state/state.json`, or use `create-admin` twice and enrol the authenticators yourself.
- `STAFF_EMAIL_DOMAIN` must be `banksphere.local` (or set `SEED_STAFF_DOMAIN` to match), and the machine running
  the seed must be inside `STAFF_ALLOWED_CIDRS` (the development `.env` allows private ranges).
- Node 22 or later for the seed; Docker for k6.

## 1. Seed users

```bash
node loadtest/seed.mjs --users 50 --admin-state frontend/e2e/.state/state.json
# or with explicit credentials
SEED_ADMIN_EMAIL=ops.lead@banksphere.local SEED_ADMIN_PASSWORD=... SEED_ADMIN_TOTP_SECRET=... \
SEED_ADMIN2_EMAIL=ops.second@banksphere.local SEED_ADMIN2_PASSWORD=... SEED_ADMIN2_TOTP_SECRET=... \
  node loadtest/seed.mjs --users 50
```

Customers are `lt.<prefix>.<i>@loadtest.test` (`--prefix`, default `u`) with `SEED_PASSWORD`. Each gets
SAVINGS + CURRENT topped up to `--balance-paise` (default ₹10,000) by a teller cash deposit. The output is
`loadtest/.data/users.json` (mode 0600). `node loadtest/seed.mjs --help` lists every option.

What it does on the stack, and why it is safe to repeat:

- **Staff, the production way.** A KYC officer and a teller are requested by one administrator and approved by
  the other, activated from the Mailpit email and enrolled with an authenticator. Their secrets live in
  `loadtest/.data/seed-state.json`; the KYC officer is reused on later runs.
- **Teller cash rules hold.** One session per teller per (IST) business day, a zero float, at most
  `TELLER_DAILY_LIMIT_PAISE` (₹10 lakh) a day per teller (another teller is onboarded when needed), no deposit
  above the single-approval limit. Each drawer is closed with the exact count and signed off by an administrator,
  so the session reconciles with no discrepancy. A drawer left open by an interrupted run is closed on the next.
- **Idempotent.** Existing customers are reused and only topped up by what is missing; registered-but-unverified
  ones are finished from a fresh verification email; deposits carry deterministic `Idempotency-Key`s.
- **No credential-stuffing signal.** New customers are registered rather than probed with a failed sign-in, and a
  stale `users.json` (from a reset stack) is detected with a single probe.
- **Rate limits.** Registration and sign-in share auth-service's per-IP credential limiter (30 per 15 minutes in
  production settings, 500 with the development overlay). Two credential calls per new customer means about 250
  new customers per 15 minutes from one machine; the seed waits out short `Retry-After`s but stops on a 15-minute
  window, so seed large pools in batches (re-running continues where it stopped) or raise `AUTH_RATE_LIMIT_MAX` on
  the test stack.

## 2. Run k6 in Docker

The image is pinned by version and digest (resolved from Docker Hub):

```
grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8
```

Attach k6 to the stack's `edge` network and call the web container, so traffic takes the real path
(nginx, then the gateway, then the services). With Docker inside WSL, from PowerShell:

```powershell
wsl -d Ubuntu -- docker run --rm --network banksphere_edge `
  -v /mnt/d/ayuu/yash/Banking-Backend-Application/loadtest:/loadtest `
  -e BASE_URL=http://web:8080 `
  grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8 `
  run --no-usage-report --summary-export /loadtest/results/browse-smoke.json /loadtest/k6/browse.js
```

From Linux or macOS (or a WSL shell) at the repository root:

```bash
K6=grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8
docker run --rm --network banksphere_edge -v "$PWD/loadtest:/loadtest" -e BASE_URL=http://web:8080 \
  "$K6" run --no-usage-report /loadtest/k6/browse.js
```

- The users file defaults to `/loadtest/.data/users.json` (resolved next to the scripts); set `USERS_FILE` for
  another pool.
- Without the `edge` network, go through the published port:
  `--add-host=host.docker.internal:host-gateway -e BASE_URL=http://host.docker.internal:8080`.
- For a staging cluster, `BASE_URL=https://staging.example.com` and no `--network`.
- Create `loadtest/results/` first if your Docker user cannot create it (the k6 image runs as an unprivileged user).

### Scenarios and knobs

| Script | Default smoke | Default load level | Main knobs |
|---|---|---|---|
| `browse.js` | 2 views/s, 30 s | 50 views/s (~225 requests/s) | `RATE`, `PROFILE_READ_SHARE` (0.25) |
| `transfers.js` | 1/s | 10/s | `RATE`, `REPLAY_SHARE` (0.25 smoke, 0.02 otherwise) |
| `topups.js` | 0.5/s | 2/s | `RATE`, `TOPUP_AMOUNT_PAISE` (10000) |
| `assistant.js` | 0.5/s | 3/s | `RATE` (must stay under 20 messages/min per user) |
| `realtime.js` | 5 streams, 20 s holds | 500 streams, 120 s holds | `STREAMS`, `HOLD_SECONDS`, `RAMP`, `HOLD` |
| `mixed.js` | 5 requests/s + 5 streams | 200 requests/s + 1,500 streams | `TARGET_RPS`, `STREAMS`, `STREAMS_PER_RPS` (7.5) |

Profiles (`PROFILE=`, all open-model arrival rates, so a slow system builds a queue like real traffic does):

| Profile | Shape |
|---|---|
| `smoke` (default) | Constant low rate for `DURATION` (30 s), at most `MAX_VUS` (5) VUs per scenario. |
| `load` | Ramp to the target over `RAMP` (2 m), hold for `HOLD` (10 m), ramp down. |
| `stress` | Steps of 0.5x, 1x, 1.5x, 2x and 3x the target, `STEP` (3 m) each, to find the knee. |
| `soak` | Ramp over 5 m, hold the target for `SOAK` (2 h): leaks, pool exhaustion, drift. |

`THINK_SCALE=0` removes think times (pure throughput); `MAX_VUS` caps the VU pool.

The mix in `mixed.js` (share of HTTP requests): browse 80 %, other screens 12 %, transfers 4 %, assistant 3 %,
top-ups 1 %. Money movements are therefore 5 % of requests, as in the design. Streams default to
`TARGET_RPS x 7.5` (about 60k open apps at 8k requests/s, the capacity plan's ratio), capped at 4 per seeded user.

### Thresholds (pass or fail)

| Journey | Latency | Errors |
|---|---|---|
| browse, other | p95 < 300 ms, p99 < 800 ms | `http_req_failed` < 1 % (abort above 5 %), checks > 99 % |
| transfers | p95 < 800 ms, p99 < 1.5 s | same, plus every replay returns the original transfer, no business refusals |
| topups | p95 < 1.5 s per request, journey p95 < 12 s (includes 2-6 s in checkout) | same |
| assistant | time to first byte p95 < 2 s, full answer p95 < 15 s | same |
| realtime | | 99 % of streams held for the full hold time (abort below) |
| all | | no 429 (`rate_limited`): a rate-limited run measured the limiter, not the system |

Sign-ins and refreshes are tagged `journey:auth` and never count towards a journey's latency.

### Rate limits when testing from one machine

All k6 traffic comes from one address, and every VU shares one of the seeded users, so the edge limits apply
long before the services saturate. A test stack must be configured for the run, never the production values:

- **Per IP at the gateway.** Today `GATEWAY_RATE_LIMIT_PER_MINUTE` (300 in production, 5,000 with the development
  overlay, which is only ~83 requests/s). After the edge upgrade (design section 10): per IP 600/min with a burst of
  200. Raise them on the test stack for any `load` run.
- **Per user** (design section 10): 300 requests/min, `money-write` 30/min (transfers and top-up orders), assistant
  20 messages/min. Seed enough users: at least `requests/s x 60 / 250`, `money writes/s x 60 / 25` and
  `assistant messages/s x 60 / 18`. `assistant.js` and `mixed.js` refuse to start above the assistant limit.
- **Sign-ins.** Each VU signs in once: the credential limiter (500 per 15 minutes with the development overlay)
  caps the VU count of one run.
- **Real-time.** At most 5 streams per user, so `STREAMS / 5` users at least (`realtime.js` checks).

### What k6 cannot see

k6 has no Server-Sent Events client. `assistant.js` reads the complete stream after the server ends it, so its
time to first byte is the first event (`message.start`), not the first token. `realtime.js` holds a stream with a
GET whose timeout is the hold time: a stream that lasts the full hold (or ends with the server's `reauth`) is a
success, an early refusal or close is a failure, but events delivered while holding are not visible (k6 drops the
body of a timed-out request and logs a "Request Failed" warning per hold, which is expected). Event delivery and
`Last-Event-ID` replay are covered by the API e2e suite. One k6 container holds a few thousand streams; spread
larger counts over several machines (or the k6 operator).

## 3. From results to the capacity plan

The capacity plan needs, per tier, the **sustained requests per second one replica handles within its SLO**. Measure
it like this, and write down every number with its conditions:

1. Run the stack on hardware close to production (CPU and memory limits per container as in
   `deploy/k8s/overlays/production`), with the tier under test at **exactly one replica** and everything else
   over-provisioned (`docker-compose.scale.yml`, or a staging namespace), so the tier is the bottleneck.
2. Pick the scenario that loads that tier: `browse.js` for account and transaction reads, `transfers.js` for the
   ledger write path, `topups.js` for payment-service, `assistant.js` for assistant-service, `realtime.js` for
   real-time connections per replica, `mixed.js` for the gateway and web tiers.
3. Run `PROFILE=load` at increasing `RATE` (for example doubling, then bisecting) until a threshold fails. The last
   passing rate is the knee. `PROFILE=stress` finds the region quickly; confirm the knee with a `load` run, since a
   10-minute hold catches queueing that a 3-minute step hides.
4. Per-replica throughput = the knee's request rate (iterations/s x requests per iteration, or simply the
   `http_reqs` rate of that journey) / replicas of the tier. Repeat with two replicas: if it does not roughly
   double, the bottleneck is downstream (database, Redis, Kafka) and the plan must say so.
5. Record date, commit, container CPU and memory limits, replica counts, rate, p95, p99, error rate, and the tier's
   CPU at the knee (Grafana's platform overview) in the capacity plan's TO BE MEASURED cells. Never round up.

### Keeping results

- `--summary-export /loadtest/results/<scenario>-<date>.json` writes the end-of-test summary as JSON.
- `--out json=/loadtest/results/<scenario>-<date>.json` keeps every sample (large; gzip it).
- With the observability overlay, stream metrics into Prometheus to see k6 next to the services' own metrics:
  start Prometheus with `--web.enable-remote-write-receiver`, then add
  `-o experimental-prometheus-rw -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write` and
  `--tag testid=<name>` so runs can be told apart.

## Validating the scripts

```bash
# Syntax and options of every scenario, without a seeded stack (uses the fake users file)
for s in browse transfers topups assistant realtime mixed; do
  docker run --rm -v "$PWD/loadtest:/loadtest:ro" -e USERS_FILE=/loadtest/k6/fixtures/users.example.json \
    "$K6" inspect /loadtest/k6/$s.js > /dev/null && echo "$s ok"
done
node --check loadtest/seed.mjs
```

`topups.js`, `assistant.js`, `realtime.js` and `mixed.js` need payment-service (simulator mode),
assistant-service and realtime-service; against a stack without them they fail their checks with 404s.
