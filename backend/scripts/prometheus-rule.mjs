#!/usr/bin/env node
/**
 * Renders deploy/k8s/components/prometheus-operator/prometheusrule.yaml from the Compose stack's alert rules
 * (backend/docker/observability/prometheus/alerts.yml), so both deployments page on exactly the same conditions.
 *
 *   node backend/scripts/prometheus-rule.mjs            # rewrite the PrometheusRule
 *   node backend/scripts/prometheus-rule.mjs --check    # exit 1 if it is out of date (CI)
 *
 * The rules file's `groups:` block is copied verbatim under `spec:`; nothing is parsed or reformatted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = path.join(repoDir, 'backend', 'docker', 'observability', 'prometheus', 'alerts.yml');
const target = path.join(repoDir, 'deploy', 'k8s', 'components', 'prometheus-operator', 'prometheusrule.yaml');

const rules = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
const start = rules.search(/^groups:\s*$/m);
if (start < 0) throw new Error(`${source}: no top-level "groups:" key`);
const groups = rules
  .slice(start)
  .trimEnd()
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n');

const rendered = `# GENERATED from backend/docker/observability/prometheus/alerts.yml by backend/scripts/prometheus-rule.mjs.
# Edit the source file, then re-run the script. Runbooks: docs/operations/runbooks.md
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: banksphere
  labels:
    # The default ruleSelector of kube-prometheus-stack; change it to match your Prometheus
    release: kube-prometheus-stack
spec:
${groups}
`;

const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
if (process.argv.includes('--check')) {
  if (current !== rendered) {
    console.error(`${path.relative(repoDir, target)} is out of date; run node backend/scripts/prometheus-rule.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(repoDir, target)} is up to date`);
} else {
  fs.writeFileSync(target, rendered);
  console.log(`wrote ${path.relative(repoDir, target)}`);
}
