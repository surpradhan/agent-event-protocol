# OTLP Receiver Note

For Phase 12a, we use the standard OTLP receiver provided by OpenTelemetry Collector:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
```

**Why:** The standard OTLP receiver is battle-tested and handles all OTEL SDK clients (Go, Python, Java, JavaScript, etc.). A custom receiver would duplicate this work with no additional benefit for Phase 12a.

**Future (Phase 12b):** If we need to add AEP-specific receiver features (e.g., automatic instrumentation hints, custom attribute mappings), we can implement `aepotlpreceiver/` here.

## Standard OTLP Receiver

The OTLP (OpenTelemetry Protocol) receiver is the primary way to send data to the Collector. It's recommended for all use cases.

See: https://github.com/open-telemetry/opentelemetry-collector/tree/main/receiver/otlpreceiver
