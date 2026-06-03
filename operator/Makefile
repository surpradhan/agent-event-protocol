# AEP Operator Makefile

# Tool versions
CONTROLLER_GEN_VERSION ?= v0.14.0
ENVTEST_VERSION        ?= release-0.17

# Image settings
IMG          ?= ghcr.io/surpradhan/aep-operator:latest
SIDECAR_IMG  ?= ghcr.io/surpradhan/aep-sidecar:latest

# Go settings
GOBIN ?= $(shell go env GOPATH)/bin

.PHONY: all build test lint generate manifests install uninstall deploy undeploy help

all: generate manifests build

## Build the operator binary
build:
	go build -o bin/operator ./cmd/operator/...

## Run all unit tests
test:
	go test ./... -v -count=1

## Run linter
lint:
	golangci-lint run ./...

## Generate DeepCopyObject implementations
generate:
	$(GOBIN)/controller-gen object:headerFile="hack/boilerplate.go.txt" paths="./..."

## Generate CRD, RBAC, and webhook manifests from Go types
manifests:
	$(GOBIN)/controller-gen \
		crd rbac:roleName=operator-role webhook \
		paths="./..." \
		output:crd:artifacts:config=config/crd \
		output:rbac:artifacts:config=config/rbac \
		output:webhook:artifacts:config=config/webhook

## Install CRDs into the current cluster
install:
	kubectl apply -f config/crd/

## Uninstall CRDs from the current cluster
uninstall:
	kubectl delete --ignore-not-found -f config/crd/

## Deploy operator to the current cluster
deploy:
	kubectl apply -f config/

## Undeploy operator from the current cluster
undeploy:
	kubectl delete --ignore-not-found -f config/

## Build and push Docker image
docker-build:
	docker build -t $(IMG) .

docker-push:
	docker push $(IMG)

## Install controller-gen
.PHONY: controller-gen
controller-gen:
	go install sigs.k8s.io/controller-tools/cmd/controller-gen@$(CONTROLLER_GEN_VERSION)

## Install setup-envtest
.PHONY: envtest
envtest:
	go install sigs.k8s.io/controller-runtime/tools/setup-envtest@$(ENVTEST_VERSION)

help:
	@grep -E '^##' Makefile | sed 's/## //'
