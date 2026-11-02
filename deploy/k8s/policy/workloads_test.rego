# Unit tests for workloads.rego (conftest verify --policy policy): each rule must fire on the violation it
# exists for, and a compliant set must pass, so a policy edit cannot silently turn a check into a no-op.
package main

import rego.v1

good_deployment := {
	"apiVersion": "apps/v1",
	"kind": "Deployment",
	"metadata": {"name": "svc"},
	"spec": {
		"selector": {"matchLabels": {"app.kubernetes.io/name": "svc"}},
		"template": {
			"metadata": {"labels": {"app.kubernetes.io/name": "svc"}},
			"spec": {
				"automountServiceAccountToken": false,
				"terminationGracePeriodSeconds": 45,
				"securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
				"topologySpreadConstraints": [{"maxSkew": 1, "topologyKey": "topology.kubernetes.io/zone", "whenUnsatisfiable": "ScheduleAnyway"}],
				"containers": [{
					"name": "app",
					"image": "registry.example.com/svc@sha256:0000000000000000000000000000000000000000000000000000000000000000",
					"securityContext": {
						"allowPrivilegeEscalation": false,
						"readOnlyRootFilesystem": true,
						"capabilities": {"drop": ["ALL"]},
					},
					"resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"memory": "256Mi"}},
					"startupProbe": {"httpGet": {"path": "/health/live", "port": "http"}},
					"livenessProbe": {"httpGet": {"path": "/health/live", "port": "http"}},
					"readinessProbe": {"httpGet": {"path": "/health", "port": "http"}},
					"lifecycle": {"preStop": {"sleep": {"seconds": 10}}},
				}],
			},
		},
	},
}

hpa := {
	"apiVersion": "autoscaling/v2",
	"kind": "HorizontalPodAutoscaler",
	"metadata": {"name": "svc"},
	"spec": {"minReplicas": 2, "maxReplicas": 4, "scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": "svc"}},
}

pdb := {
	"apiVersion": "policy/v1",
	"kind": "PodDisruptionBudget",
	"metadata": {"name": "svc"},
	"spec": {"maxUnavailable": 1, "selector": {"matchLabels": {"app.kubernetes.io/name": "svc"}}},
}

combined(objects) := [{"path": "rendered.yaml", "contents": objects}]

container_with(field, value) := object.union(
	good_deployment.spec.template.spec.containers[0],
	{"securityContext": object.union(good_deployment.spec.template.spec.containers[0].securityContext, {field: value})},
)

deployment_with_container(c) := json.patch(good_deployment, [{"op": "replace", "path": "/spec/template/spec/containers/0", "value": c}])

test_compliant_set_passes if {
	count(deny) == 0 with input as combined([good_deployment, hpa, pdb])
}

test_writable_root_filesystem_denied if {
	bad := deployment_with_container(container_with("readOnlyRootFilesystem", false))
	"Deployment/svc/app: readOnlyRootFilesystem must be true" in deny with input as combined([bad, hpa, pdb])
}

test_privilege_escalation_denied if {
	bad := deployment_with_container(container_with("allowPrivilegeEscalation", true))
	"Deployment/svc/app: allowPrivilegeEscalation must be false" in deny with input as combined([bad, hpa, pdb])
}

test_root_user_denied if {
	bad := json.patch(good_deployment, [{"op": "replace", "path": "/spec/template/spec/securityContext/runAsUser", "value": 0}])
	"Deployment/svc/app: must not run as uid 0" in deny with input as combined([bad, hpa, pdb])
}

test_missing_seccomp_denied if {
	bad := json.patch(good_deployment, [{"op": "remove", "path": "/spec/template/spec/securityContext/seccompProfile"}])
	"Deployment/svc/app: seccompProfile must be RuntimeDefault (or Localhost)" in deny with input as combined([bad, hpa, pdb])
}

test_capabilities_not_dropped_denied if {
	bad := deployment_with_container(container_with("capabilities", {"drop": ["NET_RAW"]}))
	"Deployment/svc/app: capabilities must drop ALL" in deny with input as combined([bad, hpa, pdb])
}

test_token_automount_denied if {
	bad := json.patch(good_deployment, [{"op": "remove", "path": "/spec/template/spec/automountServiceAccountToken"}])
	"Deployment/svc: automountServiceAccountToken must be false" in deny with input as combined([bad, hpa, pdb])
}

test_missing_probe_denied if {
	bad := json.patch(good_deployment, [{"op": "remove", "path": "/spec/template/spec/containers/0/readinessProbe"}])
	"Deployment/svc/app: readinessProbe is required" in deny with input as combined([bad, hpa, pdb])
}

test_missing_memory_limit_denied if {
	bad := json.patch(good_deployment, [{"op": "remove", "path": "/spec/template/spec/containers/0/resources/limits"}])
	"Deployment/svc/app: resources.limits.memory must be set" in deny with input as combined([bad, hpa, pdb])
}

test_latest_tag_denied if {
	bad := json.patch(good_deployment, [{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "registry.example.com/svc:latest"}])
	"Deployment/svc/app: image \"registry.example.com/svc:latest\" needs an explicit tag or digest (and never :latest)" in deny with input as combined([bad, hpa, pdb])
}

test_fixed_replicas_denied if {
	bad := json.patch(good_deployment, [{"op": "add", "path": "/spec/replicas", "value": 3}])
	"Deployment/svc: spec.replicas must not be set (the HorizontalPodAutoscaler owns it)" in deny with input as combined([bad, hpa, pdb])
}

test_deployment_without_hpa_or_pdb_denied if {
	denials := deny with input as combined([good_deployment])
	"Deployment/svc: no HorizontalPodAutoscaler targets it" in denials
	"Deployment/svc: no PodDisruptionBudget selects its pods" in denials
}

test_secret_object_denied if {
	secret := {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "leak"}, "stringData": {"k": "v"}}
	"Secret/leak: Secret objects must not be rendered from git; use an ExternalSecret" in deny with input as combined([good_deployment, hpa, pdb, secret])
}

test_namespace_without_restricted_psa_denied if {
	ns := {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "banksphere", "labels": {}}}
	denials := deny with input as combined([ns])
	"Namespace/banksphere: Pod Security Admission must enforce \"restricted\"" in denials
	"a default-deny NetworkPolicy (empty podSelector, Ingress and Egress) is required" in denials
}

test_load_balancer_service_denied if {
	svc := {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "svc"}, "spec": {"type": "LoadBalancer"}}
	"Service/svc: only ClusterIP Services; traffic enters through the Ingress" in deny with input as combined([svc])
}

test_unpinned_image_warns if {
	tagged := json.patch(good_deployment, [{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "registry.example.com/svc:1.2.3"}])
	count(deny) == 0 with input as combined([tagged, hpa, pdb])
	count(warn) == 1 with input as combined([tagged, hpa, pdb])
}
