# Builds a Collector distribution that INCLUDES the AEP exporter, via the
# OpenTelemetry Collector Builder (ocb). The prebuilt contrib image cannot be
# used because the `aep` exporter is a custom component.
#
# Build context must be the repository ROOT (builder-config.yaml's replaces
# reference ../ and ../../sdks/go relative to the generated _build/go.mod).
#
#   docker build -f otelbridge/Dockerfile -t aep-collector .
#
# NOTE: this OCB build has not yet been exercised in CI — see README "Status".
FROM golang:1.21 AS build
RUN go install go.opentelemetry.io/collector/cmd/builder@v0.96.0

WORKDIR /src
COPY sdks/go/ ./sdks/go/
COPY otelbridge/ ./otelbridge/

WORKDIR /src/otelbridge
RUN builder --config builder-config.yaml

FROM gcr.io/distroless/static:nonroot
COPY --from=build /src/otelbridge/_build/aep-collector /aep-collector
COPY otelbridge/collector-config.yaml /etc/collector-config.yaml
ENTRYPOINT ["/aep-collector"]
CMD ["--config", "/etc/collector-config.yaml"]
