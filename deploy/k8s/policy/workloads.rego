# Hardening policy for the RENDERED manifests (kustomize build output), run by validate.sh with conftest:
#   kustomize build overlays/production | conftest test --combine --policy policy -
# The baseline lives in base/patches; this proves the result, so a new service, an overlay patch or a hand edit
# cannot quietly drop a control. deny = build fails, warn = reported only.
package main

import rego.v1

docs := [doc | some file in input; some doc in documents(file.contents)]

# conftest hands a multi-document file over as an array, a single document as an object
documents(contents) := contents if is_array(contents)

documents(contents) := [contents] if is_object(contents)

workload_kinds := {"Deployment", "StatefulSet", "DaemonSet", "Job"}

workloads := [doc | some doc in docs; doc.kind in workload_kinds]

id(doc) := sprintf("%s/%s", [doc.kind, doc.metadata.name])

all_containers(spec) := array.concat(object.get(spec, "containers", []), object.get(spec, "initContainers", []))

# Container setting, falling back to the pod-level securityContext (Kubernetes' own precedence)
effective(spec, c, field) := object.get(
	object.get(c, "securityContext", {}), field,
	object.get(object.get(spec, "securityContext", {}), field, null),
)

# --- pod level --------------------------------------------------------------------------------------------

deny contains msg if {
	some w in workloads
	object.get(w.spec.template.spec, "automountServiceAccountToken", true) != false
	msg := sprintf("%s: automountServiceAccountToken must be false", [id(w)])
}

deny contains msg if {
	some w in workloads
	some flag in ["hostNetwork", "hostPID", "hostIPC"]
	object.get(w.spec.template.spec, flag, false) == true
	msg := sprintf("%s: %s is not allowed", [id(w), flag])
}

deny contains msg if {
	some w in workloads
	some v in object.get(w.spec.template.spec, "volumes", [])
	v.hostPath
	msg := sprintf("%s: hostPath volume %q is not allowed", [id(w), v.name])
}

# --- every container --------------------------------------------------------------------------------------

deny contains msg if {
	some w in workloads
	spec := w.spec.template.spec
	some c in all_containers(spec)
	effective(spec, c, "runAsNonRoot") != true
	msg := sprintf("%s/%s: runAsNonRoot must be true", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	spec := w.spec.template.spec
	some c in all_containers(spec)
	effective(spec, c, "runAsUser") == 0
	msg := sprintf("%s/%s: must not run as uid 0", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	spec := w.spec.template.spec
	some c in all_containers(spec)
	not seccomp_confined(effective(spec, c, "seccompProfile"))
	msg := sprintf("%s/%s: seccompProfile must be RuntimeDefault (or Localhost)", [id(w), c.name])
}

seccomp_confined(profile) if {
	is_object(profile)
	profile.type in {"RuntimeDefault", "Localhost"}
}

deny contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	object.get(object.get(c, "securityContext", {}), "allowPrivilegeEscalation", true) != false
	msg := sprintf("%s/%s: allowPrivilegeEscalation must be false", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	object.get(object.get(c, "securityContext", {}), "readOnlyRootFilesystem", false) != true
	msg := sprintf("%s/%s: readOnlyRootFilesystem must be true", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	object.get(object.get(c, "securityContext", {}), "privileged", false) == true
	msg := sprintf("%s/%s: privileged containers are not allowed", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	caps := object.get(object.get(c, "securityContext", {}), "capabilities", {})
	not "ALL" in object.get(caps, "drop", [])
	msg := sprintf("%s/%s: capabilities must drop ALL", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	count(object.get(object.get(object.get(c, "securityContext", {}), "capabilities", {}), "add", [])) > 0
	msg := sprintf("%s/%s: no capabilities may be added", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	some path in [["requests", "cpu"], ["requests", "memory"], ["limits", "memory"]]
	object.get(object.get(c, "resources", {}), path, null) == null
	msg := sprintf("%s/%s: resources.%s.%s must be set", [id(w), c.name, path[0], path[1]])
}

deny contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	not image_pinned(c.image)
	msg := sprintf("%s/%s: image %q needs an explicit tag or digest (and never :latest)", [id(w), c.name, c.image])
}

image_pinned(image) if contains(image, "@sha256:")

image_pinned(image) if {
	not contains(image, "@")
	parts := split(image, "/")
	contains(parts[count(parts) - 1], ":")
	not endswith(image, ":latest")
}

warn contains msg if {
	some w in workloads
	some c in all_containers(w.spec.template.spec)
	not contains(c.image, "@sha256:")
	msg := sprintf("%s/%s: image %q is not pinned by digest yet (the release pipeline must set one)", [id(w), c.name, c.image])
}

# --- long-running workloads -------------------------------------------------------------------------------

deny contains msg if {
	some w in workloads
	w.kind == "Deployment"
	some c in w.spec.template.spec.containers
	some probe in ["startupProbe", "livenessProbe", "readinessProbe"]
	not c[probe]
	msg := sprintf("%s/%s: %s is required", [id(w), c.name, probe])
}

deny contains msg if {
	some w in workloads
	w.kind == "Deployment"
	some c in w.spec.template.spec.containers
	not c.lifecycle.preStop
	msg := sprintf("%s/%s: a preStop hook is required (endpoint removal must propagate before SIGTERM)", [id(w), c.name])
}

deny contains msg if {
	some w in workloads
	w.kind == "Deployment"
	object.get(w.spec.template.spec, "terminationGracePeriodSeconds", 30) < 30
	msg := sprintf("%s: terminationGracePeriodSeconds must be at least 30", [id(w)])
}

# The HPA owns the replica count; a value here would reset it on every apply
deny contains msg if {
	some w in workloads
	w.kind == "Deployment"
	w.spec.replicas
	msg := sprintf("%s: spec.replicas must not be set (the HorizontalPodAutoscaler owns it)", [id(w)])
}

deny contains msg if {
	some w in workloads
	w.kind == "Deployment"
	not hpa_targets(w.metadata.name)
	msg := sprintf("%s: no HorizontalPodAutoscaler targets it", [id(w)])
}

deny contains msg if {
	some w in workloads
	w.kind == "Deployment"
	not pdb_covers(w)
	msg := sprintf("%s: no PodDisruptionBudget selects its pods", [id(w)])
}

deny contains msg if {
	some w in workloads
	w.kind == "Deployment"
	count(object.get(w.spec.template.spec, "topologySpreadConstraints", [])) == 0
	msg := sprintf("%s: topologySpreadConstraints are required", [id(w)])
}

hpa_targets(name) if {
	some h in docs
	h.kind == "HorizontalPodAutoscaler"
	h.spec.scaleTargetRef.kind == "Deployment"
	h.spec.scaleTargetRef.name == name
}

pdb_covers(w) if {
	some p in docs
	p.kind == "PodDisruptionBudget"
	count(p.spec.selector.matchLabels) > 0
	every key, value in p.spec.selector.matchLabels {
		w.spec.template.metadata.labels[key] == value
	}
}

deny contains msg if {
	some h in docs
	h.kind == "HorizontalPodAutoscaler"
	h.spec.minReplicas < 2
	msg := sprintf("%s: minReplicas must be at least 2 (one pod is a single point of failure)", [id(h)])
}

# --- other kinds ------------------------------------------------------------------------------------------

deny contains msg if {
	some sa in docs
	sa.kind == "ServiceAccount"
	object.get(sa, "automountServiceAccountToken", true) != false
	msg := sprintf("%s: automountServiceAccountToken must be false", [id(sa)])
}

# Secrets come from the secret manager (External Secrets), never from git
deny contains msg if {
	some s in docs
	s.kind == "Secret"
	msg := sprintf("%s: Secret objects must not be rendered from git; use an ExternalSecret", [id(s)])
}

deny contains msg if {
	some s in docs
	s.kind == "Service"
	object.get(s.spec, "type", "ClusterIP") != "ClusterIP"
	msg := sprintf("%s: only ClusterIP Services; traffic enters through the Ingress", [id(s)])
}

deny contains msg if {
	some ns in docs
	ns.kind == "Namespace"
	object.get(ns.metadata.labels, "pod-security.kubernetes.io/enforce", "") != "restricted"
	msg := sprintf("%s: Pod Security Admission must enforce \"restricted\"", [id(ns)])
}

deny contains msg if {
	some ns in docs
	ns.kind == "Namespace"
	not default_deny_present
	msg := "a default-deny NetworkPolicy (empty podSelector, Ingress and Egress) is required"
}

default_deny_present if {
	some np in docs
	np.kind == "NetworkPolicy"
	np.spec.podSelector == {}
	"Ingress" in np.spec.policyTypes
	"Egress" in np.spec.policyTypes
	not np.spec.ingress
	not np.spec.egress
}
