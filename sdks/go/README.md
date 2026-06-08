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

// Default (v1): envelope-only signature, base64-encoded.
signedEvent, err := aep.SignEvent(event, secret)
if err != nil {
	log.Fatal(err)
}

// Verify the signature (version-aware; honours signature.canon).
valid, err := aep.VerifySignature(signedEvent, secret)
if err != nil {
	log.Fatal(err)
}
if valid {
	log.Println("Signature verified")
}
```

#### Canonicalization versions (`signature.canon`, issue #59)

The signed *canonical form* of an event comes in two versions:

- **v1** (`SignEvent`, the default) — **envelope-only**: the `signature` field is
  dropped, top-level keys are sorted, and nested object contents are omitted (a
  `payload` serializes as `{}`). Covers the envelope but **not** nested payloads.
- **v2** (`SignEventV2`) — **deep**: the whole event including nested payloads is
  recursively key-sorted, so the signature **covers payload contents**. v2
  signatures carry a `signature.canon: "v2"` marker.

```go
// Opt into v2 so the signature covers nested payload contents.
signedEvent, err := aep.SignEventV2(event, secret)
// or, equivalently:
signedEvent, err = aep.SignEventWithCanon(event, secret, "v2")
```

`VerifySignature` is version-aware and backward-compatible: a `"v2"` marker is
verified against the deep form only, `"v1"` against the shallow form only, and an
**absent** marker is accepted if it matches *either* form (transition mode). The
digest is **base64**-encoded in both versions, byte-identical to the server, Node,
and Python SDKs (locked by a cross-language known-answer test).

> **Behaviour change (issue #59):** earlier Go SDK releases signed a *deep*
> canonical form and **hex**-encoded the value — a combination that matched
> neither the shared v1 (shallow) nor v2 form and whose hex value never verified
> on the server (everyone else uses base64), so it was non-interoperable in
> practice. This release aligns v1 to the shared **shallow + base64** form (so Go
> finally interoperates) and adds opt-in v2. Existing Go signers will produce
> different `signature.value` bytes; events signed by older Go releases were not
> verifiable cross-language anyway.
>
> **Cross-runtime byte parity:** the canonical form is built with a custom
> serializer (not `encoding/json`) so the bytes match ECMAScript `JSON.stringify`
> / Python `json.dumps(ensure_ascii=False)` exactly — including ECMAScript
> `Number` formatting (`ecmaFormatFloat`) and string escaping (`ecmaQuote`, which
> emits `<`, `>`, `&`, U+2028 and U+2029 raw, unlike `encoding/json` which escapes
> them). Verified by `TestECMANumberFormatting`, `TestEcmaQuote`, and
> server-derived known-answer vectors covering special characters.

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
