// Package aepexporter implements an OpenTelemetry Collector exporter that
// converts spans into Agent Event Protocol (AEP) events and sends them to an
// AEP ingest server.
package aepexporter

import (
	"errors"
	"time"
)

// Config is the configuration for the AEP exporter.
type Config struct {
	// ServerURL is the base URL of the AEP ingest server (e.g. http://localhost:8787).
	ServerURL string `mapstructure:"server_url"`
	// APIKey is the bearer token used to authenticate with the AEP ingest API.
	APIKey string `mapstructure:"api_key"`
	// BatchSize is the maximum number of events sent per ingest request.
	BatchSize int `mapstructure:"batch_size"`
	// FlushInterval bounds how long events may be buffered before sending.
	FlushInterval time.Duration `mapstructure:"flush_interval"`
}

// Validate checks the configuration and is invoked by the Collector core.
func (cfg *Config) Validate() error {
	if cfg.ServerURL == "" {
		return errors.New("aep: server_url is required")
	}
	if cfg.BatchSize < 0 {
		return errors.New("aep: batch_size must not be negative")
	}
	if cfg.FlushInterval < 0 {
		return errors.New("aep: flush_interval must not be negative")
	}
	return nil
}

func createDefaultConfig() *Config {
	return &Config{
		ServerURL:     "http://localhost:8787",
		BatchSize:     100,
		FlushInterval: 5 * time.Second,
	}
}
