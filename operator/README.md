# AEP Kubernetes Operator

> Phase 10 — Automatic instrumentation for agent pods running in Kubernetes.

Annotate any pod with `aep.dev/inject=true` and the operator automatically
injects an AEP sidecar that emits structured events to the AEP ingest server —
zero changes to agent code required.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Go | ≥1.22 | Build the operator |
| kubectl | ≥1.26 | Cluster operations |
| controller-gen | v0.14.0 | CRD/RBAC/webhook manifest generation |
| Docker + BuildKit | recent | Multi-arch image builds |
| kind / minikube | any | Local cluster for testing |

## Quick Start

```bash
# 1. From inside operator/ — generate go.sum and indirect deps (first-time only)
make tidy

# 2. Install code-generation tools
make controller-gen envtest

# 3. Generate DeepCopyObject implementations and manifests
make generate manifests

# 4. Build the binary
make build

# 5. Install CRDs into your current cluster
make install

# 6. Run the operator locally (against current kubeconfig)
bin/operator --aep-server-url http://localhost:8787

# 7. Version info
bin/operator --version
```

## Directory Layout

```
operator/
├── api/v1alpha1/          # CRD Go types (AgentInstrumentation)
├── cmd/operator/          # main entrypoint
├── internal/
│   ├── controller/        # Reconciler for AgentInstrumentation
│   └── webhook/           # Mutating webhook — sidecar injection
├── config/
│   ├── crd/               # Generated CRD manifests
│   ├── rbac/              # Generated RBAC manifests
│   ├── webhook/           # Generated webhook manifests
│   └── manager/           # Operator Deployment + Service
├── hack/boilerplate.go.txt
├── Makefile
└── Dockerfile
```

## How It Works

1. The operator watches `AgentInstrumentation` CRs to configure injection policy.
2. A mutating webhook intercepts Pod creation requests.
3. If the pod has `aep.dev/inject: "true"`, the webhook injects the AEP sidecar
   container with the pod's K8s metadata (`pod name`, `namespace`, `node`).
4. The sidecar emits `task.created` / `task.completed` / `error.raised` events
   to the AEP ingest server on startup and shutdown.

## Makefile Targets

Run `make help` for the full list.

## Building a Multi-Arch Image

```bash
# Builds linux/amd64 + linux/arm64 and pushes to registry
IMG=ghcr.io/yourorg/aep-operator:v0.1.0 make docker-push
```
