# Kubernetes

How BankSphere runs on Kubernetes: what is in `deploy/k8s`, what the cluster must provide, how configuration and
secrets reach the pods, how traffic is allowed, and how to roll out, migrate and roll back. The binding design is
[`docs/architecture/2026-10-28-platform-scale-design.md`](../architecture/2026-10-28-platform-scale-design.md)
(sections 2, 10 and 13); replica bounds come from [`capacity-plan.md`](capacity-plan.md).

## Topology

```
 internet ──TLS──▶ cloud LB ──▶ ingress-nginx (ns ingress-nginx)
                                  │  Ingress "web" (30 s) and "web-streams" (SSE, 1 h, unbuffered)
                                  ▼
 ns banksphere ┌──────────────────────────────────────────────────────────────────────────────────┐
               │ web ×3-12 (nginx: SPA, CSP, same-origin /api proxy, overwrites X-Forwarded-For)  │
               │   │ :8000                                                                        │
               │   ▼                                                                              │
               │ api-gateway ×6-30 ──────────────────────────────▶ edge Redis (managed)           │
               │   │ :8001-8009                                                                   │
               │   ▼                                                                              │
               │ auth  customer  account  transaction  notification  fraud  payment  assistant  realtime
               │   account ─▶ customer, transaction     payment ─▶ customer, transaction          │
               │   assistant ─▶ customer, account, transaction, payment (customer's own token)    │
               │ banksphere-migrate (Job, pre-deploy, owner roles, direct to Postgres)            │
               └───────┬───────────────┬─────────────────┬───────────────────┬──────────────────┘
                       ▼               ▼                 ▼                   ▼
             Postgres via pooler   Kafka (SASL_SSL)   security Redis     cache Redis      (all managed, private subnets)
             (pgbouncer=true)                         (AOF, noeviction)  (evictable)
 internet egress: auth, notification ─▶ SMTP 587/465     payment ─▶ Razorpay 443     assistant ─▶ LLM API 443
 ns monitoring: Prometheus ─▶ every Node pod :9464 (metrics listener, never on a Service)
```

`razorpay-simulator` is a development and e2e tool and is never deployed to a cluster.

## Layout

```
deploy/k8s/
  base/                     environment-neutral: namespace, 11 apps, migration Job, NetworkPolicies, Ingress
    apps/<service>.yaml     ServiceAccount, Deployment, Service, HPA, PDB for one service
    patches/                baseline applied to every Deployment / HPA (security context, rollout, spread)
    network/                default deny + explicit allows
    jobs/migrate.yaml       pre-deploy migrations
    ingress/ingress.yaml
  components/
    external-secrets/       ExternalSecret per Secret (remote key paths only, never values)
    prometheus-operator/    PodMonitor (optional, needs the operator's CRDs)
  overlays/staging/         bounds, sizes, hosts, data-store CIDRs, images, config for staging
  overlays/production/      the same for production
  policy/                   conftest policy for the rendered output, with unit tests
  validate.sh               build + kubeconform + policy for every target (local and CI)
```

Render with `kustomize build deploy/k8s/overlays/production` (or `kubectl kustomize`). The baseline patches
keep the per-service files short; read the rendered output, not the base, when reviewing what will run.

## What the cluster must provide

| Requirement | Why |
|---|---|
| Kubernetes 1.32 or newer (validated against 1.32 and 1.36) | `preStop.sleep` and topology-spread `matchLabelKeys` are used (default on since 1.30) |
| A CNI that enforces NetworkPolicy (Calico, Cilium, cloud CNI with policy enabled) | Without it every allow/deny below is silently ignored |
| ingress-nginx (class `nginx`) or a compatible controller, in namespace `ingress-nginx` | The Ingress annotations and the `web-ingress` NetworkPolicy assume it |
| metrics-server | HPA CPU and memory signals |
| External Secrets Operator and a `ClusterSecretStore` named `banksphere` per cluster | Creates every Secret the pods reference |
| cert-manager (or another way to create the `banksphere-web-tls` Secret) | TLS for the Ingress host |
| Optional: prometheus-operator (kube-prometheus-stack) in namespace `monitoring` | The PodMonitor; otherwise scrape by the `prometheus.io/*` pod annotations (do not do both) |
| Nodes in at least three zones, labelled `topology.kubernetes.io/zone` | Zone spreading and zone-loss tolerance |
| Managed Postgres with a transaction-mode, PgBouncer-compatible pooler; managed Kafka with SASL/SCRAM over TLS; three managed Redis instances (security, edge, cache) | Referenced by configuration and secrets, never run in the cluster |

ingress-nginx has been retired upstream (the Kubernetes project announced it in November 2025 and ended
maintenance in March 2026). The manifests use its annotations because they are what most clusters still run;
plan the move to a maintained controller or the Gateway API (an `HTTPRoute` per Ingress, with the body-size and
timeout settings below expressed in that implementation's policy resources).

### Client address chain

Per-IP rate limits, bans and the staff network check all depend on the gateway seeing the real client address:

1. The cloud load balancer must preserve it: Service `externalTrafficPolicy: Local` on the controller, or PROXY
   protocol (`use-proxy-protocol: "true"` in the controller ConfigMap).
2. ingress-nginx sets `X-Forwarded-For` for the web pods.
3. The web nginx trusts `X-Forwarded-For` only from `TRUSTED_PROXY_CIDR` (the controller pods' CIDR, set per
   overlay) and then overwrites it with the client address.
4. The gateway trusts exactly that one hop (`TRUST_PROXY=1`), and so do the services behind it.

If step 1 or 3 is wrong, every client looks like the controller and per-IP limits throttle everyone at once.

### Controller settings (ingress-nginx ConfigMap)

`hsts: "true"`, `hsts-max-age: "63072000"`, `hsts-include-subdomains: "true"`, `ssl-protocols: "TLSv1.2 TLSv1.3"`,
`allow-snippet-annotations: "false"`, `enable-real-ip` per step 1, and `worker-connections` high enough for the
open SSE streams (each stream holds a client and an upstream connection).

## Namespace, labels and the security baseline

- Namespace `banksphere` enforces Pod Security Admission `restricted`: the API server itself refuses a pod that
  could run as root, escalate, keep capabilities or skip seccomp.
- Labels: `app.kubernetes.io/name` (selectors), `app.kubernetes.io/part-of: banksphere`,
  `app.kubernetes.io/component` (`web`, `gateway`, `service`, `migration`), `banksphere.io/runtime`
  (`node`, `nginx`), `banksphere.io/environment` (overlays).
- Every workload: own ServiceAccount, no token mounted, `runAsNonRoot` with an explicit uid (1000 for the Node
  images, whose `USER node` is a name the kubelet cannot verify; 101 for nginx), read-only root filesystem with
  a size-limited `emptyDir` for `/tmp`, all capabilities dropped, no privilege escalation, `RuntimeDefault`
  seccomp, requests and limits, no service-link environment variables.
- `policy/workloads.rego` fails the build if the rendered output loses any of that, if a Deployment has no HPA or
  PDB or sets `spec.replicas`, if a `Secret` object is rendered from git, if a Service is not `ClusterIP`, or if
  the default-deny policy is missing. Images not yet pinned by digest are reported as warnings.

## Configuration and secrets

**ConfigMaps** hold non-secret settings and are generated by kustomize (`configMapGenerator`): `banksphere-common`
for everything shared, `<service>-config` per service, `web-config` for nginx. The generated name carries a
content hash, so changing a value rolls the Deployments that use it, and a rollback restores the old ConfigMap
with the old ReplicaSet.

**Secrets** are referenced by name only (`envFrom.secretRef`) and created by the External Secrets Operator from
the environment's secret manager (`components/external-secrets`). Nothing secret is in git.

| Secret | Used by | Contents (remote key path in the secret manager) |
|---|---|---|
| `banksphere-jwt` | every Node service | `JWT_VERIFY_KEYS` (`banksphere/jwt`) |
| `<service>-secrets` | that service | `DATABASE_URL` (app role, through the pooler, `pgbouncer=true`), `REDIS_URL` / `RATE_LIMIT_REDIS_URL` / `CACHE_REDIS_URL` (ACL user per service, `rediss://`), its Kafka SCRAM password (`banksphere/kafka`), the internal tokens it presents or checks (`banksphere/internal-tokens`), provider credentials (Razorpay, SMTP, LLM) |
| `banksphere-migrate-secrets` | migration Job | schema OWNER URLs straight to Postgres (`banksphere/migrate`) |
| `banksphere-web-tls` | Ingress | certificate for the public host (cert-manager) |

Each cluster has its own `ClusterSecretStore` named `banksphere` pointing at that environment's secret manager
(separate cloud account or project, or a separate Vault mount), so the same paths resolve to different values
per environment and staging can never read production secrets. Example for AWS Secrets Manager with IRSA:

```yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: banksphere
spec:
  provider:
    aws:
      service: SecretsManager
      region: ap-south-1
      auth:
        jwt:
          serviceAccountRef: { name: external-secrets, namespace: external-secrets }
  conditions:
    - namespaces: [banksphere]
```

**Rotation.** Environment variables are read once at start-up, so a rotated value takes effect on the next pod
start. Change the value in the secret manager, wait for the ExternalSecret to refresh (`refreshInterval: 1h`, or
annotate it with `force-sync=$(date +%s)`), then `kubectl -n banksphere rollout restart deployment/<name>`
(the PDB and `maxUnavailable: 0` keep capacity whole). Credentials with two sides rotate in two steps:

- Database, Redis and Kafka passwords: add the new password or user on the data store, roll the services, then
  remove the old one.
- Internal tokens: the callee must accept old and new for one rollout, or roll callee and caller together in a
  quiet window.
- JWT signing key: add the new public key to `JWT_VERIFY_KEYS` and roll every service; then switch
  `JWT_SIGNING_KEY` / `JWT_SIGNING_KEY_ID` and roll auth-service; remove the old public key after the longest
  token lifetime (refresh tokens: `JWT_REFRESH_EXPIRATION_DAYS`).
- Razorpay webhook secret: Razorpay signs with one secret at a time; rotate in the dashboard and the secret
  manager together, then roll payment-service. The reconciler settles anything a rejected webhook missed.

## Network policy

Default deny for ingress and egress on every pod, then explicit allows that mirror the Compose networks. Every
pod may resolve DNS through `kube-system/kube-dns`. Kubelet probes come from the node and are not affected.

| From | To | Port | Mirrors |
|---|---|---|---|
| ingress-nginx controller pods | web | 8080 | `edge` |
| web | api-gateway | 8000 | `edge` |
| api-gateway | auth, customer, account, transaction, notification, fraud, payment, assistant, realtime | 8001-8009 | `apps` |
| account | customer 8002, transaction 8004 | | internal APIs |
| payment | customer 8002, transaction 8004 (`/internal/v1/payments`) | | internal APIs |
| assistant | customer 8002, account 8003, transaction 8004, payment 8007 | | read-only tools |
| auth, customer, account, transaction, notification, fraud, payment, assistant, migrate | Postgres / pooler CIDR | 5432, 6432 | `backend` |
| auth, account, transaction, notification, fraud, payment, realtime | Kafka CIDR | 9092-9098 | `backend` |
| every service except the gateway | security Redis CIDR | 6379-6380 | `backend` |
| api-gateway, auth | edge Redis CIDR | 6379-6380 | `apps` |
| customer, account, transaction, payment, assistant, realtime | cache Redis CIDR | 6379-6380 | `backend` |
| auth, notification | internet (not private, CGNAT, link-local) | 587, 465 | `egress` |
| payment, assistant | internet (not private, CGNAT, link-local) | 443 | `egress` |
| `monitoring` Prometheus pods | every Node pod | 9464 | metrics |

The base uses TEST-NET-1 addresses (`192.0.2.0/24`) for the data stores, which route nowhere; each overlay
replaces them with the real private subnets. A NetworkPolicy cannot match host names: to restrict the internet
egress to the SMTP relay, `api.razorpay.com` and the LLM endpoint themselves, add an egress gateway or an
FQDN-aware policy (for example Cilium `toFQDNs`) where the platform has one. IPv6 egress is not allowed at all.

## Scaling

The HPA owns every replica count (Deployments do not set `spec.replicas`, which would reset the count on each
apply). It scales on CPU (70 % of requests) and memory (80 %), doubles within 30 s on a surge, and removes at most
20 % a minute after 5 calm minutes; realtime-service sheds one pod every 3 minutes after 15 calm minutes, because
every pod removed makes its streams reconnect at once.

| Service | Staging min-max | Production min-max | Production requests / limits |
|---|---|---|---|
| web | 2-3 | 3-12 | 100m, 64Mi / 500m, 256Mi |
| api-gateway | 2-4 | 6-30 | 500m, 384Mi / 1500m, 768Mi |
| auth-service | 2-3 | 3-12 | 500m, 256Mi / 1500m, 512Mi |
| customer-service | 2-3 | 3-10 | 250m, 256Mi / 1, 512Mi |
| account-service | 2-3 | 3-12 | 250m, 256Mi / 1, 512Mi |
| transaction-service | 2-4 | 4-20 | 500m, 384Mi / 1500m, 768Mi |
| notification-service | 2-3 | 2-12 | 250m, 256Mi / 1, 512Mi |
| fraud-service | 2-3 | 2-12 | 250m, 256Mi / 1, 512Mi |
| payment-service | 2-3 | 3-10 | 250m, 256Mi / 1, 512Mi |
| assistant-service | 2-3 | 2-10 | 250m, 256Mi / 1, 512Mi |
| realtime-service | 2-4 | 3-15 | 250m, 512Mi / 1, 1Gi |

- The bounds are derived in [`capacity-plan.md`](capacity-plan.md) from provisional per-replica throughput;
  revise them (and the requests, which the utilisation targets are measured against) once the k6 numbers are
  measured.
- Kafka consumer groups cannot use more members than the 12 partitions per topic, so the consumer services stop
  at 12. Raising that ceiling means adding partitions first (they only ever grow).
- The gateway caps open streams per replica at `GATEWAY_MAX_STREAMS` (5000): 30 replicas bound open streams at
  150 000.
- Every Deployment has a PodDisruptionBudget of `maxUnavailable: 1` with `unhealthyPodEvictionPolicy:
  AlwaysAllow`, so node drains proceed one pod at a time and a crash-looping pod never blocks one.
- Pods spread across zones and nodes with `whenUnsatisfiable: ScheduleAnyway`: if a zone is out of capacity, a
  scale-up still lands elsewhere instead of staying pending during a peak. The production minimum of 3 or more
  replicas plus the PDB keeps a zone loss survivable.

## Probes and shutdown

| Probe | Node services | api-gateway | web |
|---|---|---|---|
| startup | `/health/live`, up to 2 min | same | `/healthz` |
| liveness | `/health/live` (process only) | same | `/healthz` |
| readiness | `/health` (own database and Redis) | `/health/live` | `/healthz` |

Liveness never checks dependencies, so a database incident cannot make the kubelet restart healthy processes.
The gateway's `/health` reports its critical upstreams; using it for readiness would pull every gateway out of
the Service when one upstream fails and turn a partial outage into a full one, so the gateway is ready while its
process is, and its circuit breakers answer `503 UPSTREAM_UNAVAILABLE` for just the affected routes.

On termination: the pod leaves the endpoints, `preStop` sleeps 10 s while kube-proxy, the ingress controller and
the gateway's keep-alive pools catch up, then SIGTERM starts the app's graceful shutdown (stop accepting,
finish in-flight requests, force exit after 15 s). Grace periods: 45 s for the Node services, 60 s for the
gateway, realtime and web (streams), 90 s for the assistant (an answer can take the 30 s LLM timeout plus tool
rounds). Streams cut at the end are resumed by the browser (`Last-Event-ID` for real-time events).

## Rollout

1. **Build once.** CI builds each image once; the release pipeline pins it by digest in the overlay
   (`kustomize edit set image banksphere/<svc>=registry/...@sha256:<digest>`) and promotes the same digests from
   staging to production.
2. **Validate.** `bash deploy/k8s/validate.sh overlays/<env>` (CI does this on every change under `deploy/`).
3. **Migrate.** The `banksphere-migrate` Job must finish before the new pods start (below).
4. **Apply.** `RollingUpdate` with `maxSurge: 25%`, `maxUnavailable: 0`: new pods must pass readiness before
   old ones go, so capacity never drops. `progressDeadlineSeconds: 600` marks a stuck rollout as failed.
5. **Watch.** `kubectl -n banksphere rollout status deployment/<name>` and the SLO dashboards
   ([`slos.md`](slos.md), [`observability.md`](observability.md)); roll back on a burn-rate alert.

With **Argo CD**, the Job is a `PreSync` hook (`hook-delete-policy: BeforeHookCreation`) and steps 3-4 are one
sync. With **plain kubectl**:

```bash
kubectl -n banksphere delete job banksphere-migrate --ignore-not-found      # a Job's pod template is immutable
kubectl apply -k deploy/k8s/overlays/production -l 'app.kubernetes.io/component notin (web,gateway,service)'
kubectl -n banksphere wait --for=condition=complete job/banksphere-migrate --timeout=15m
kubectl apply -k deploy/k8s/overlays/production
```

The first apply creates everything except the app Deployments (namespace, config, ExternalSecrets, network
policy, Services, HPAs and the Job), so the Job has its secret and its database route before it starts. If the
wait times out or the Job fails, stop: read `kubectl -n banksphere logs job/banksphere-migrate`, fix, and run the
Job again; the old version keeps serving.

## Migrations

The Job applies every service's Prisma migrations (`prisma migrate deploy`), each as that schema's OWNER role, in
a fixed order, connecting straight to Postgres (sessions and advisory locks do not work through a
transaction-mode pooler). Prisma's own advisory lock makes a concurrent second run wait. A missing owner URL fails
the Job instead of skipping a schema.

Because the Job runs before the new pods and the old pods keep serving during the rollout, every migration must
work with both versions (**expand, then contract**):

- Release N adds (nullable or defaulted columns, new tables, new indexes created `CONCURRENTLY` in their own
  migration) and the code writes both old and new shapes.
- Release N+1 (or later) backfills in batches and switches reads.
- Only a later release drops or renames what nothing reads any more.
- No long table rewrites or locks inside the deploy window: run big backfills as separate, resumable jobs.

## Rollback

- **Application:** `kubectl -n banksphere rollout undo deployment/<name>` restores the previous ReplicaSet,
  including its hashed ConfigMap. With GitOps, revert the commit that changed the digests so the cluster and git
  agree; Argo CD then syncs the previous digests.
- **Migrations are forward-only.** Nothing is rolled back in the database; expand/contract is what makes the
  previous application version still work against the newer schema. If a migration itself is wrong, ship a new
  forward migration that repairs it.
- **Configuration:** revert the overlay change; the old ConfigMap content gets the old hash back and the pods
  roll.
- **Secrets:** the secret manager's version history; set the previous version current, let ESO refresh, restart.

## Validation

`bash deploy/k8s/validate.sh` (needs only Docker; the tool images are pinned by digest):

1. `conftest verify` runs the policy's unit tests (each rule must fire on its violation).
2. `kustomize build` renders base, staging and production.
3. `kubeconform -strict -summary` checks every object against the Kubernetes 1.32 and 1.36 schemas and the CRDs
   (ExternalSecret, PodMonitor) against the community CRD catalogue; unknown fields fail.
4. `conftest test --combine` applies `policy/workloads.rego` to the rendered output.

`.github/workflows/deploy-manifests.yml` runs the same script on every change under `deploy/` and keeps the
rendered manifests as a build artifact for review.

## Before the first production deploy

- Fill in every `# placeholder` in `overlays/production/kustomization.yaml`: staff VPN CIDR, Kafka brokers,
  ingress-controller pod CIDR, public host, SMTP host, data-store subnets, registry.
- Create the `banksphere` ClusterSecretStore and every remote key listed in
  `components/external-secrets/external-secrets.yaml` (an empty `LLM_API_KEY` selects the built-in assistant).
- Create Postgres roles and schemas (owner and app role per service, as `backend/docker/postgres/init-schemas.sh`
  does locally), the pooler, Kafka users, ACLs and topics with 12 partitions (`backend/docker/kafka/init.sh` is
  the reference), and the Redis ACL users.
- Confirm the namespace and pod labels of the ingress controller and Prometheus match `network/` (or patch them).
- Set the controller's client-address handling (section "Client address chain") and its connection limits.
- Decide on the PodMonitor or annotation scraping, not both.
- Run the k6 suite against staging and update `capacity-plan.md`, the HPA bounds and the requests.
