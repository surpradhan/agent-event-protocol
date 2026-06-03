# AEP Go SDK

A production-ready Go client library for the Agent Event Protocol (AEP) v0.2.0.

## Installation

```bash
go get github.com/surpradhan/aep-go
```

## Quick Start

### Creating an Event

```go
package main

import (
	"context"
	"log"

	"github.com/surpradhan/aep-go/aep"
)

func main() {
	// Create an event
	event, err := aep.CreateEvent(
		"agent://my-agent",
		aep.EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "analyze document"},
		nil,
	)
	if err != nil {
		log.Fatal(err)
	}

	// Validate it
	result, err := aep.ValidateEvent(event)
	if err != nil {
		log.Fatal(err)
	}
	if !result.Valid {
		log.Fatal("Event validation failed:", result.Errors)
	}

	log.Printf("Event created: %s\n", event.ID)
}
```

### Emitting Events (Sync)

```go
client := aep.NewClient()
client.SetAPIKey("aep_...")

ctx := context.Background()
resp, err := client.Emit(ctx, event)
if err != nil {
	log.Fatal(err)
}
log.Printf("Event emitted: %s (duplicate: %v)\n", resp.ID, resp.Duplicate)
```

### Emitting Events (Async)

```go
asyncClient := aep.NewAsyncClient()
asyncClient.SetAPIKey("aep_...")

ctx := context.Background()

// Emit multiple events concurrently
events := []*aep.Event{event1, event2, event3}
results, err := asyncClient.EmitBatch(ctx, events)
if err != nil {
	log.Fatal(err)
}

for _, result := range results {
	log.Printf("Event %s emitted\n", result.ID)
}
```

### Signing Events

```go
secret := "my_shared_secret"
signedEvent, err := aep.SignEvent(event, secret)
if err != nil {
	log.Fatal(err)
}

// Verify the signature
valid, err := aep.VerifySignature(signedEvent, secret)
if err != nil {
	log.Fatal(err)
}
if valid {
	log.Println("Signature verified")
}
```

## Features

- **Sync & Async Clients**: Both `Client` and `AsyncClient` with context-aware timeouts
- **Event Validation**: JSON Schema validation using jsonschema v5
- **HMAC Signing**: HMAC-SHA256 event signing with constant-time verification
- **Full Endpoint Coverage**: Support for `/events`, `/health`, `/ready`, `/metrics`, `/sessions`
- **Error Handling**: Comprehensive error hierarchy with specific types
- **Type Safety**: Enums for `EventType` and `AgentRole`

## API Reference

### Event Types

- `EventTypeTaskCreated` / `EventTypeTaskUpdated` / `EventTypeTaskCompleted` / `EventTypeTaskFailed`
- `EventTypeToolCalled` / `EventTypeToolResult`
- `EventTypeMemoryRead` / `EventTypeMemoryWrite`
- `EventTypeHandoffStarted` / `EventTypeHandoffCompleted`
- `EventTypePolicyBlocked` / `EventTypeErrorRaised`

### Client Methods

#### Sync Client

- `Emit(ctx, event)` — send a single event
- `EmitBatch(ctx, events)` — send multiple events synchronously
- `GetSession(ctx, sessionID)` — retrieve session metadata
- `GetHealth(ctx)` — check server health
- `GetReady(ctx)` — check server readiness
- `GetMetrics(ctx)` — retrieve server metrics

#### Async Client

- `EmitAsync(ctx, event)` — send a single event asynchronously
- `EmitBatch(ctx, events)` — send multiple events concurrently and wait for all
- `EmitBatchConcurrent(ctx, events)` — send multiple events and stream results

## Testing

### Unit Tests

Run unit tests (no server required):

```bash
go test ./aep -v
```

### Integration Tests

Integration tests connect to a real AEP server and are automatically skipped if the server is unreachable.

Run integration tests:

```bash
go test -tags=integration ./aep -v
```

Configure server URL for integration tests:

```bash
SERVER_URL=http://your-server:8787 go test -tags=integration ./aep -v
```

## Coverage

Run tests with coverage:

```bash
go test ./aep -coverage
go test ./aep -cover -v
```

## Documentation

- [AEP PRD](../../AEP_PRD.md)
- [API Specification](../../README.md)
- [Schema Reference](../../schemas/)

## License

MIT
