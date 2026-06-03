# ── Build stage ──────────────────────────────────────────────────────────────
# BUILDPLATFORM is the host platform (where docker build runs).
# TARGETPLATFORM / TARGETOS / TARGETARCH describe the image being produced.
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /workspace

# Cache dependency downloads separately from source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/      cmd/
COPY api/      api/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -a -ldflags="-s -w" -o bin/operator ./cmd/operator/...

# ── Runtime stage ─────────────────────────────────────────────────────────────
# distroless/static:nonroot already runs as UID 65532 — no USER override needed.
FROM gcr.io/distroless/static:nonroot

WORKDIR /
COPY --from=builder /workspace/bin/operator .

ENTRYPOINT ["/operator"]
