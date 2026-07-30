# AEP Kubernetes Operator

> Phase 10 — Automatic instrumentation for agent pods running in Kubernetes.

A Kubernetes operator (CRD + mutating admission webhook) that automates AEP sidecar injection for annotated pods.

> **📍 Project direction (2026-06):** AEP is converging on OpenTelemetry rather than continuing as a standalone protocol. The operator is **parked** — it remains published and usable as a reference implementation (bugfixes welcome), but is not receiving new-feature investment; active development has moved toward contributions to the OTel GenAI semantic conventions.

Annotate any pod with `aep.dev/inject=true` and the operator automatically
injects an AEP observability sidecar that emits structured events to the AEP
ingest server — zero changes to agent code required.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Go | ≥1.22 | Build the operator |
| kubectl | ≥1.26 | Cluster operations |
| controller-gen | v0.14.0 | CRD/RBAC/webhook manifest generation |
| cert-manager | ≥1.0.0 | Webhook TLS (or provide your own Secret) |
| Docker + BuildKit | recent | Multi-arch image builds |
| kind / minikube | any | Local cluster for integration testing |

---

## Quick Start (Helm — recommended)

```bash
# Add the repo (once published)
# helm repo add aep https://surpradhan.github.io/agent-event-protocol
# helm repo update

# Install with cert-manager TLS (requires cert-manager in the cluster)
helm install aep-operator ./helm/aep-operator \
  --create-namespace \
  --namespace aep-system

# Create an AgentInstrumentation to enable injection
kubectl apply -f - <<EOF
apiVersion: aep.dev/v1alpha1
kind: AgentInstrumentation
metadata:
  name: default
spec:
  enabled: true
  aepServerURL: http://aep-ingest.aep-system.svc.cluster.local:8787
  apiKeySecretRef:
    name: aep-api-key
    key: token
EOF

# Opt a pod in to injection
kubectl annotate pod my-agent-pod aep.dev/inject=true

# Check injection status
kubectl get ainstr
```

## Quick Start (raw manifests)

```bash
cd operator

# 1. Generate go.sum (first-time only)
make tidy

# 2. Install code-generation tools (first-time only)
make controller-gen envtest

# 3. Generate DeepCopy implementations and manifests
make generate manifests

# 4. Install CRDs into your current cluster
make install

# 5. Deploy RBAC, webhook, and manager
make deploy

# 6. Run the operator locally against your current kubeconfig
bin/operator \
  --aep-server-url http://localhost:8787 \
  --sidecar-image ghcr.io/surpradhan/aep-sidecar:latest

# 7. Print version info
bin/operator --version
```

---

## How It Works

```
Pod CREATE admission request
        │
        ├─ aep.dev/inject ≠ "true"  → Allowed (no-op)
        ├─ aep.dev/inject = "false" → Allowed (explicit opt-out)
        ├─ aep.dev/injected = "true" → Allowed (already injected)
        │
        └─ findCoveringInstrumentation()
              ├─ None / disabled  → Allowed (no patch)
              └─ Found ──────────→ JSON patch:
                                    • aep.dev/injected=true annotation
                                    • aep-sidecar container appended
                                         ├─ AEP_SERVER_URL
                                         ├─ AEP_NAMESPACE, AEP_POD_NAME,
                                         │  AEP_NODE_NAME, AEP_POD_UID (downward API)
                                         ├─ AEP_API_KEY (from Secret, if configured)
                                         └─ spec.env overrides

AgentInstrumentation reconciler (every 5 min + on change):
  1. spec.enabled=false → Ready=False (Disabled)
  2. List matching namespaces → list pods with aep.dev/injected=true
  3. Update status.injectedCount, status.conditions (Ready=True/Active)
```

---

## `AgentInstrumentation` CRD Reference

```yaml
apiVersion: aep.dev/v1alpha1
kind: AgentInstrumentation
metadata:
  name: my-instrumentation   # cluster-scoped
spec:
  enabled: true              # toggle injection without deleting (default: true)

  namespaceSelector:         # optional: restrict to matching namespaces
    matchLabels:
      aep.dev/instrumented: "true"

  podSelector:               # optional: restrict to matching pods within namespaces
    matchLabels:
      app.kubernetes.io/component: agent

  aepServerURL: "http://..."  # optional: override operator --aep-server-url

  apiKeySecretRef:            # optional: Bearer token for AEP auth
    name: aep-api-key
    key: token

  sidecarImage: "..."         # optional: override operator --sidecar-image

  resources:                  # optional: sidecar CPU/memory (defaults: 5m/16Mi req, 100m/64Mi lim)
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      cpu: 200m
      memory: 64Mi

  env:                        # optional: extra env vars for the sidecar (last wins)
    - name: AEP_LOG_LEVEL
      value: debug
```

**Multiple resources:** when two `AgentInstrumentation` resources cover the same
namespace, the one whose name sorts alphabetically first takes precedence. Keep
`namespaceSelector` / `podSelector` non-overlapping to avoid surprises.

**Status:**

```bash
$ kubectl get ainstr
NAME      ENABLED   INJECTED   READY   AGE
default   true      12         True    5m
```

---

## Directory Layout

```
operator/
├── api/v1alpha1/
│   ├── agentinstrumentation_types.go   # Spec, Status, condition constants
│   ├── groupversion_info.go            # SchemeBuilder, AddToScheme
│   └── zz_generated.deepcopy.go       # DeepCopy (overwritten by make generate)
├── cmd/operator/
│   └── main.go                         # Manager entrypoint (--aep-server-url, --sidecar-image, --version)
├── internal/
│   ├── controller/
│   │   ├── agentinstrumentation_controller.go  # Reconciler
│   │   └── agentinstrumentation_controller_test.go  # 10 unit tests
│   └── webhook/
│       ├── sidecar_injector.go         # Mutating webhook handler
│       └── sidecar_injector_test.go    # 12 unit tests
├── config/
│   ├── crd/                            # CRD YAML (also in helm/crds/)
│   ├── rbac/                           # ClusterRole + ClusterRoleBinding
│   ├── webhook/                        # MWC, Service, cert-manager Certificate
│   └── manager/                        # Deployment + Namespace
├── helm/aep-operator/                  # Helm chart (v0.1.0)
│   ├── Chart.yaml
│   ├── values.yaml
│   ├── crds/
│   └── templates/
├── tests/
│   └── integration_test.go             # envtest integration tests (build tag: integration)
├── go.mod                              # module: github.com/surpradhan/aep-operator
├── Makefile
└── Dockerfile                          # distroless multi-arch image
```

---

## Testing

```bash
# Unit tests (no cluster required)
make test

# Integration tests (requires envtest binaries)
make envtest
source <(setup-envtest use 1.29 -p env)
make test-integration
```

| Suite | Count | Tag |
|-------|-------|-----|
| Controller unit | 10 | (default) |
| Webhook unit | 12 | (default) |
| Integration (envtest) | 4 | `integration` |

---

## Configuration Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--aep-server-url` | `http://aep-ingest.aep-system.svc.cluster.local:8787` | AEP ingest server URL |
| `--sidecar-image` | `ghcr.io/surpradhan/aep-sidecar:latest` | Sidecar container image |
| `--leader-elect` | `false` | Enable leader election (set `true` in production) |
| `--metrics-bind-address` | `:8080` | Prometheus metrics endpoint |
| `--health-probe-bind-address` | `:8081` | Liveness/readiness probes |
| `--version` | — | Print version and exit |

---

## Helm Chart Values

See [`helm/aep-operator/values.yaml`](helm/aep-operator/values.yaml) for the
full annotated reference. Key values:

| Value | Default | Description |
|-------|---------|-------------|
| `image.tag` | `""` (→ appVersion) | Operator image tag |
| `aepServerURL` | in-cluster URL | AEP server |
| `leaderElect` | `true` | Leader election |
| `webhook.enabled` | `true` | Enable sidecar injection |
| `webhook.certManager.enabled` | `true` | Use cert-manager for TLS |
| `webhook.namespaceSelector` | excludes kube-system, kube-public | Webhook routing scope |
| `webhook.timeoutSeconds` | `10` | Admission timeout |

---

## Building a Multi-Arch Image

```bash
IMG=ghcr.io/surpradhan/aep-operator:v0.1.0 make docker-push
```

Produces `linux/amd64` and `linux/arm64` layers via Docker BuildKit.
