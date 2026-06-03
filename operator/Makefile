# AEP Operator Makefile

# ── Versions ──────────────────────────────────────────────────────────────────
CONTROLLER_GEN_VERSION ?= v0.14.0
ENVTEST_VERSION        ?= v0.17.3

# ── Image settings ────────────────────────────────────────────────────────────
IMG         ?= ghcr.io/surpradhan/aep-operator:latest
SIDECAR_IMG ?= ghcr.io/surpradhan/aep-sidecar:latest

# ── Build metadata (injected via ldflags) ────────────────────────────────────
VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
GIT_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
BUILD_DATE ?= $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS    := -s -w \
	-X main.version=$(VERSION) \
	-X main.gitCommit=$(GIT_COMMIT) \
	-X main.buildDate=$(BUILD_DATE)

# ── Go settings ───────────────────────────────────────────────────────────────
GOBIN ?= $(shell go env GOPATH)/bin

.PHONY: all build test test-integration lint tidy generate manifests install uninstall \
        deploy undeploy docker-build docker-push controller-gen envtest help

all: generate manifests build ## Run generate + manifests + build

# ── Development ───────────────────────────────────────────────────────────────

build: ## Build the operator binary (with version ldflags)
	go build -ldflags="$(LDFLAGS)" -o bin/operator ./cmd/operator/...

test: ## Run all unit tests (excludes integration tests)
	go test $(shell go list ./... | grep -v /tests) -v -count=1

test-integration: ## Run integration tests (requires: make envtest + KUBEBUILDER_ASSETS)
	@echo "Ensure KUBEBUILDER_ASSETS is set: source <(setup-envtest use 1.29 -p env)"
	go test -tags integration ./tests/... -v -count=1 -timeout 120s

lint: ## Run golangci-lint
	golangci-lint run ./...

tidy: ## Run go mod tidy (required after first clone and after adding deps)
	go mod tidy

# ── Code generation ───────────────────────────────────────────────────────────

generate: ## Generate DeepCopyObject implementations via controller-gen
	$(GOBIN)/controller-gen object:headerFile="hack/boilerplate.go.txt" paths="./..."

manifests: ## Generate CRD, RBAC, and webhook manifests from Go type markers
	$(GOBIN)/controller-gen \
		crd rbac:roleName=operator-role webhook \
		paths="./..." \
		output:crd:artifacts:config=config/crd \
		output:rbac:artifacts:config=config/rbac \
		output:webhook:artifacts:config=config/webhook

# ── Cluster operations ────────────────────────────────────────────────────────

install: ## Install CRDs into the current cluster
	kubectl apply -f config/crd/

uninstall: ## Uninstall CRDs from the current cluster
	kubectl delete --ignore-not-found -f config/crd/

deploy: ## Deploy operator to current cluster (CRDs → RBAC → manager, in order)
	kubectl apply -f config/crd/
	kubectl apply -f config/rbac/
	kubectl apply -f config/webhook/
	kubectl apply -f config/manager/

undeploy: ## Undeploy operator from current cluster
	kubectl delete --ignore-not-found -f config/manager/
	kubectl delete --ignore-not-found -f config/webhook/
	kubectl delete --ignore-not-found -f config/rbac/
	kubectl delete --ignore-not-found -f config/crd/

# ── Docker ────────────────────────────────────────────────────────────────────

docker-build: ## Build operator Docker image (multi-arch via BuildKit)
	docker buildx build --platform linux/amd64,linux/arm64 -t $(IMG) .

docker-push: ## Push operator Docker image
	docker buildx build --platform linux/amd64,linux/arm64 -t $(IMG) --push .

# ── Tool installation ─────────────────────────────────────────────────────────

controller-gen: ## Install controller-gen
	go install sigs.k8s.io/controller-tools/cmd/controller-gen@$(CONTROLLER_GEN_VERSION)

envtest: ## Install setup-envtest
	go install sigs.k8s.io/controller-runtime/tools/setup-envtest@$(ENVTEST_VERSION)

# ── Help ──────────────────────────────────────────────────────────────────────

help: ## Display this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} \
	/^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' \
	$(MAKEFILE_LIST)
