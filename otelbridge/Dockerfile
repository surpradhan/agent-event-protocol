# Builds a Collector distribution that INCLUDES the AEP exporter, via the
# OpenTelemetry Collector Builder (ocb). The prebuilt contrib image cannot be
# used because the `aep` exporter is a custom component.
#
# Build context must be the repository ROOT (builder-config.yaml's replaces
# reference ../ and ../../sdks/go relative to the generated _build/go.mod).
#
#   docker build -f otelbridge/Dockerfile -t aep-collector .
#
# Go 1.24 + GOTOOLCHAIN=auto: ocb runs an unpinned `go get`, which pulls
# current transitive deps that require a newer toolchain than the collector's
# declared go 1.21. Verified building a working binary with the aep exporter.
FROM golang:1.24 AS build
ENV GOTOOLCHAIN=auto
RUN go install go.opentelemetry.io/collector/cmd/builder@v0.96.0

WORKDIR /src
COPY sdks/go/ ./sdks/go/
COPY otelbridge/ ./otelbridge/

WORKDIR /src/otelbridge
RUN builder --config builder-config.yaml

# debian-slim (not distroless) so the demo's compose entrypoint can use a shell
# to read the bootstrapped API key; glibc matches the golang:1.24 build image
# (the collector is built with cgo, so a musl/alpine runtime would not load it).
FROM debian:bookworm-slim
COPY --from=build /src/otelbridge/_build/aep-collector /aep-collector
COPY otelbridge/collector-config.yaml /etc/collector-config.yaml
ENTRYPOINT ["/aep-collector"]
CMD ["--config", "/etc/collector-config.yaml"]
