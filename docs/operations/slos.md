# Service level objectives

What BankSphere promises its users, how each promise is measured, and what happens when it is at risk. The alert
rules in `backend/docker/observability/prometheus/alerts.yml` (and the Kubernetes PrometheusRule) implement these;
every alert links to a section of [runbooks.md](runbooks.md).

All SLOs are measured **at the edge** (the `api-gateway` service's `http_server_requests_seconds` histogram) over a
rolling 30 days, unless a row says otherwise. Streaming routes (real-time and Sphere answers) are excluded from
latency objectives because their duration is the length of the conversation, not the speed of the system.

## Objectives

| # | Promise | SLI | Objective | Error budget (30 days) |
|---|---|---|---|---|
| 1 | The app answers | share of edge responses that are not 5xx | 99.9 % | 43 min of full outage, or 0.1 % of requests |
| 2 | Pages feel instant | p95 latency of non-streaming edge requests | ≤ 300 ms | 5 % of 5-minute windows may exceed it |
| 3 | Money moves promptly | p95 of `POST /api/v1/transactions/transfer` | ≤ 1 s | as 2 |
| 4 | A paid top-up is credited | share of CAPTURED top-ups CREDITED (or CREDIT_BLOCKED) within 5 minutes | 99.9 % | 1 in 1,000 may need the reconciler's later runs |
| 5 | Events are not lost or late | oldest unpublished outbox event, every service | < 2 min, 99.5 % of the time | 3.6 h per month above 2 min |
| 6 | Live updates arrive | real-time event delivered to an open stream within 5 s of the commit | 99 % | best effort beyond that: the browser refetches on reconnect |
| 7 | Sphere answers | share of assistant messages that end `complete` (builtin fallback counts as complete) | 99 % | an LLM outage is absorbed by the built-in assistant |

Never traded against any budget: **ledger correctness** (every posting balanced, idempotent, reconciled) and
**authorization** (every route policy enforced). These are tested, not measured; an incident in either is a
severity-1 regardless of how small.

## How the budget is spent

- **Burn-rate alerting** for objective 1: `ErrorBudgetBurnFast` pages when the last hour and the last five
  minutes both burn more than 14.4× the sustainable rate (2 % of the monthly budget in one hour).
  `HighErrorRatio` catches a single service failing even when the edge average still looks healthy.
- **Latency** (`SlowRequests`) warns after 10 minutes above 300 ms at p95, per service, with a minimum volume.
- **Money paths** have their own alerts that page regardless of the budget: `OutboxBacklog`,
  `PaymentReconcilerFailing`, `PaymentReconcilerStopped`, `CircuitBreakerOpen`.

When more than half of a month's budget for objective 1 or 2 is gone, feature releases pause in favour of
reliability work until the rolling window recovers.

## What is deliberately not promised

- Throughput of a single replica. Capacity is a function of replica count; see [capacity-plan.md](capacity-plan.md).
- Availability of third parties (Razorpay, the LLM provider, SMTP). Their failures surface as degraded features:
  top-ups wait in CAPTURED or REFUND_PENDING for the reconciler, Sphere falls back to the built-in assistant,
  emails are retried from Kafka. None of these may fail a request that doesn't need them.
