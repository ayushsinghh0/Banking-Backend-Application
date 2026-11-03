#!/usr/bin/env bash
# Renders every kustomization and checks the output; needs only Docker (every tool image is pinned by digest).
# Used locally and by .github/workflows/deploy-manifests.yml.
#   bash deploy/k8s/validate.sh                      # base + every overlay
#   bash deploy/k8s/validate.sh overlays/production  # just one
#   RENDER_DIR=out bash deploy/k8s/validate.sh       # also keep the rendered YAML (one file per target)
#
# 0. conftest verify: the policy's own unit tests (policy/workloads_test.rego)
# 1. kustomize build (the official image)
# 2. kubeconform -strict, for each of K8S_VERSIONS: every object against that release's OpenAPI schemas, CRDs
#    (External Secrets, prometheus-operator) against the community CRD catalogue; unknown fields or kinds fail
# 3. conftest test: policy/workloads.rego, the hardening rules (non-root, read-only root, no capabilities,
#    seccomp, probes, HPA + PDB per Deployment, no Secret objects, PSA restricted, default-deny network policy)
set -euo pipefail

KUSTOMIZE_IMAGE="registry.k8s.io/kustomize/kustomize:v5.8.3@sha256:429eda4a1c76a7de458d0c4ca3ded9b5d764899ff6bdaeccc1d98b1b6ee873e4"
KUBECONFORM_IMAGE="ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e"
CONFTEST_IMAGE="openpolicyagent/conftest:v0.71.1@sha256:0e77cdf7c1fcde035f3c579e4aaa6664ee2a8be5777eaa9af9f520cdd02280c0"
# The oldest Kubernetes minor supported (preStop `sleep` and topology matchLabelKeys need >= 1.30, on by default)
# and a current one, so neither a removed nor a not-yet-available field slips through
K8S_VERSIONS="${K8S_VERSIONS:-1.32.0 1.36.0}"
CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work" 2>/dev/null || true' EXIT
mkdir -p "$work/schemas"

if [ "$#" -gt 0 ]; then targets=("$@"); else targets=(base overlays/staging overlays/production); fi

echo "== policy unit tests"
docker run --rm -v "$here/policy:/policy:ro" "$CONFTEST_IMAGE" verify --no-color --policy /policy

for target in "${targets[@]}"; do
  echo "== $target"
  rendered="$work/$(echo "$target" | tr '/' '-').yaml"
  docker run --rm -v "$here:/k8s:ro" "$KUSTOMIZE_IMAGE" build "/k8s/$target" > "$rendered"
  echo "rendered $(grep -c '^kind:' "$rendered") objects"

  for version in $K8S_VERSIONS; do
    echo "-- kubeconform, Kubernetes $version"
    # Downloaded schemas are cached for the rest of the run
    docker run --rm -i --user "$(id -u):$(id -g)" -v "$work/schemas:/cache" "$KUBECONFORM_IMAGE" \
      -strict -summary -cache /cache -kubernetes-version "$version" \
      -schema-location default -schema-location "$CRD_SCHEMAS" - < "$rendered"
  done

  echo "-- conftest"
  docker run --rm -i -v "$here/policy:/policy:ro" "$CONFTEST_IMAGE" \
    test --combine --no-color --policy /policy - < "$rendered"

  if [ -n "${RENDER_DIR:-}" ]; then
    mkdir -p "$RENDER_DIR"
    cp "$rendered" "$RENDER_DIR/"
  fi
done
echo "All targets valid: ${targets[*]}"
