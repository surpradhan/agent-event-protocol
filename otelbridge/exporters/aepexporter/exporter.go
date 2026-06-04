package aepexporter

import (
	"context"

	"github.com/surpradhan/aep-go/aep"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.uber.org/zap"
)

// aepExporter converts OTEL traces to AEP events and emits them to the ingest API.
type aepExporter struct {
	cfg    *Config
	client *aep.Client
	logger *zap.Logger
}

func newAEPExporter(cfg *Config, logger *zap.Logger) *aepExporter {
	client := aep.NewClientWithURL(cfg.ServerURL)
	if cfg.APIKey != "" {
		client.SetAPIKey(cfg.APIKey)
	}
	return &aepExporter{cfg: cfg, client: client, logger: logger}
}

// consumeTraces maps the spans in td to AEP events and sends them in batches.
// Spans that cannot be mapped are skipped; a transport failure on any batch is
// returned so the Collector can apply its retry/queue behaviour.
func (e *aepExporter) consumeTraces(ctx context.Context, td ptrace.Traces) error {
	events := tracesToEvents(td)
	if len(events) == 0 {
		return nil
	}

	batchSize := e.cfg.BatchSize
	if batchSize <= 0 {
		batchSize = len(events)
	}

	for start := 0; start < len(events); start += batchSize {
		end := start + batchSize
		if end > len(events) {
			end = len(events)
		}
		if _, err := e.client.EmitBatch(ctx, events[start:end]); err != nil {
			return err
		}
	}

	return nil
}

func (e *aepExporter) shutdown(context.Context) error {
	return e.client.Close()
}
