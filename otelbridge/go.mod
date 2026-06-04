module github.com/surpradhan/aep-otel-bridge

go 1.21

require (
	github.com/surpradhan/aep-go v0.0.0
	go.opentelemetry.io/collector/component v0.96.0
	go.opentelemetry.io/collector/consumer v0.96.0
	go.opentelemetry.io/collector/exporter v0.96.0
	go.opentelemetry.io/collector/pdata v1.3.0
)

// The AEP Go SDK is developed in this repository; use the local copy.
replace github.com/surpradhan/aep-go => ../sdks/go
