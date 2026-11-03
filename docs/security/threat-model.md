# Threat model: payments, assistant, real-time updates and the edge

Scope: the capabilities added in the platform upgrade (design: `docs/architecture/2026-10-28-platform-scale-design.md`).
The core banking threats (theft between accounts, staff abuse, token theft, ledger tampering) are covered in
`docs/security/2026-10-27-security-audit.md` and stay in force. Method: STRIDE per trust boundary; each threat lists
its mitigation and where it is enforced.

## Trust boundaries

1. Browser ⇄ web (nginx) ⇄ gateway: the internet.
2. Razorpay ⇄ gateway (webhooks): an external party we authenticate by signature.
3. Gateway ⇄ services ⇄ data stores: internal networks, per-service credentials.
4. assistant-service ⇄ LLM provider: an external processor of customer questions.

## Payments (Razorpay top-ups)

| Threat | STRIDE | Mitigation | Enforced in |
|---|---|---|---|
| Forged "payment succeeded" from the browser | Spoofing | HMAC of `order_id\|payment_id` with the key secret, constant-time compare; then the payment is fetched from Razorpay and order, amount, currency and status must match | payment-service confirm |
| Forged or replayed webhook | Spoofing, Tampering | HMAC over the exact raw body with the webhook secret; dedupe on the event id; optional source-network allowlist | payment-service webhook |
| Double credit (browser + webhook + reconciler racing) | Tampering | Credit idempotent on the top-up id (unique ledger reference); guarded state transitions with version checks | ledger internal API, payment-service |
| Paying a small amount, getting credited a large one | Tampering | Credited amount is always the order's amount, and only when Razorpay's captured amount equals it; mismatches go to CREDIT_BLOCKED | payment-service |
| Topping up someone else's account | Elevation | Account ownership checked against the ledger with the payment service's own credential | payment-service, ledger |
| Laundering via top-up then immediate transfer out | Repudiation | Daily top-up cap, KYC VERIFIED required, fraud rule RAPID_PASS_THROUGH | payment-service, fraud-service |
| Refund to the wrong party or by one insider | Elevation | Refunds only by BANK_ADMIN with a fresh authenticator step-up; Razorpay refunds to the original instrument only; audited in a hash chain | payment-service |
| payment-service compromise moves arbitrary money | Elevation | Its ledger credential only allows top-up credits/refunds against customer accounts it names, never provisioning or closing; every posting is double-entry and reconciled | ledger internal router |
| Simulator reachable in production | Spoofing | Service refuses to start in production with the simulator or a non-HTTPS API base; the simulator itself refuses NODE_ENV=production and only exists in the dev overlay | payment-service, simulator |
| Card data exposure | Information disclosure | Card and UPI details never touch BankSphere: Razorpay Checkout runs in Razorpay's frame; CSP admits only Razorpay's hosts and only when enabled | web (nginx CSP) |

## Sphere assistant

| Threat | STRIDE | Mitigation | Enforced in |
|---|---|---|---|
| Prompt injection to read another customer's data | Information disclosure | Tools call the owning services with the customer's own token; the services authorize; the assistant has no privileges | assistant-service tools |
| Prompt injection to move money | Elevation | No write tools exist; transfers are drafts that open the normal step-up protected transfer screen | assistant-service |
| Injected instructions inside transaction descriptions | Tampering | Tool output is passed as data with an explicit instruction that it is never instructions; outputs are minimised and masked | assistant-service prompt |
| Staff using the assistant to bypass the staff network rule | Elevation | The assistant authenticates every request (staff network enforced by role) and staff get only the help tool | assistant-service |
| Cost exhaustion of the LLM account | Denial of service | Per-user message rate (GCRA), per-user daily token budget, bounded tool rounds and output tokens, 30 s timeout | assistant-service, gateway |
| Customer data sent to a third party | Information disclosure | Built-in engine by default (no data leaves); with an LLM configured only masked, minimal tool data is sent; message bodies are never logged; 30-day retention | assistant-service |

## Real-time updates

| Threat | STRIDE | Mitigation | Enforced in |
|---|---|---|---|
| Subscribing to someone else's events | Information disclosure | Channels derive only from the verified token (user id, role); no client-chosen channel names | realtime-service |
| A revoked session keeps receiving events | Elevation | Streams end at access-token expiry (`reauth`), so revocation takes effect within one token lifetime; new streams check revocation | realtime-service |
| Connection exhaustion | Denial of service | Per-user stream cap across replicas, per-replica cap, gateway stream cap, heartbeats and idle cleanup | realtime-service, gateway |
| Sensitive data in events | Information disclosure | Events carry ids, types and amounts only; the browser refetches details through authorized APIs | realtime-service mapping |

## Edge and identity

| Threat | STRIDE | Mitigation | Enforced in |
|---|---|---|---|
| Credential stuffing from one source | Spoofing | Per-IP distinct-account failure counting (HyperLogLog) → temporary edge ban; per-account lockouts remain | auth-service, gateway |
| Rate-limit evasion by forging a token's subject | Spoofing | The gateway keys per-user limits only on signature-verified tokens | gateway |
| Abusive networks | Denial of service | Administrator IP deny rules (validated: width, no staff overlap, not the admin's own address), mirrored to the edge | auth-service, gateway |
| Overload of one service cascading | Denial of service | Load shedding at the gateway, circuit breakers per upstream, PgBouncer caps on database backends, fail-fast Redis clients | gateway, common |
| Unnoticed session theft | Spoofing | Sessions and devices visible to the customer with remote sign-out; new-device sign-in emails; security events retained 180 days | auth-service |
| Audit history rewritten by a privileged insider | Repudiation | Append-only triggers plus hash-chained audit rows with an administrator verification endpoint | auth, ledger, payment |
| Metrics or internals exposed | Information disclosure | Metrics on a separate port never routed by the gateway or nginx; health answers only UP/DEGRADED | common, nginx |

## Residual risks (accepted, tracked)

- The access-token lifetime bounds how fast a revoked session's open real-time stream closes (15 minutes by default).
- Built-in assistant answers are deterministic but limited; an LLM gives better answers at the cost of sending masked data to the provider. This is a configuration choice per deployment.
- Credential-stuffing bans never apply inside `STAFF_ALLOWED_CIDRS`, so an attacker inside the office network is only stopped by per-account lockouts.
- A single Kafka broker and single Postgres instance in the Compose deployment are availability risks; the Kubernetes deployment expects managed, replicated services.
