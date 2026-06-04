package aepexporter

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
)

const (
	typeStr   = "aep"
	stability = component.StabilityLevelBeta
)

// NewFactory returns a Collector exporter factory for the AEP exporter.
func NewFactory() exporter.Factory {
	return exporter.NewFactory(
		component.MustNewType(typeStr),
		func() component.Config { return createDefaultConfig() },
		exporter.WithTraces(createTracesExporter, stability),
	)
}

func createTracesExporter(
	ctx context.Context,
	set exporter.CreateSettings,
	cfg component.Config,
) (exporter.Traces, error) {
	c := cfg.(*Config)
	exp := newAEPExporter(c, set.Logger)

	return exporterhelper.NewTracesExporter(
		ctx,
		set,
		cfg,
		exp.consumeTraces,
		exporterhelper.WithShutdown(exp.shutdown),
	)
}
