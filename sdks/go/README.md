# AEP Go SDK

A production-ready Go client library for the Agent Event Protocol (AEP) v0.2.0.

## Installation

The Go SDK is a **subdirectory module** of the
[`agent-event-protocol`](https://github.com/surpradhan/agent-event-protocol)
monorepo — its module path is the repo path plus the `sdks/go` subdirectory:

```bash
go get github.com/surpradhan/agent-event-protocol/sdks/go@latest
```

Pin a specific release instead of `@latest` with a bare semver version query —
Go maps it to the underlying subdirectory-prefixed Git tag (`sdks/go/v0.3.0`)
automatically, and `@v0.3.0` is what ends up in your `go.mod` `require` line
(see [Releasing](#releasing-publishing)):

```bash
go get github.com/surpradhan/agent-event-protocol/sdks/go@v0.3.0
```

Import the package as:

```go
import "github.com/surpradhan/agent-event-protocol/sdks/go/aep"
```

## Quick Start

### Creating an Event

```go
package main

import (
	"context"
	"log"

	"github.com/surpradhan/agent-event-protocol/sdks/go/aep"
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

// Default (v2): deep, payload-covering signature, base64-encoded, marked canon="v2".
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

- **v2** (`SignEvent`, the default, also `SignEventV2`) — **deep**: the whole event
  including nested payloads is recursively key-sorted, so the signature **covers
  payload contents**. v2 signatures carry a `signature.canon: "v2"` marker. This
  is now the default so payload tamper-evidence is on without opt-in.
- **v1** (`SignEventV1`) — legacy **envelope-only**: the `signature` field is
  dropped, top-level keys are sorted, and nested object contents are omitted (a
  `payload` serializes as `{}`). Covers the envelope but **not** nested payloads.

```go
// Legacy envelope-only form (e.g. to talk to a server predating v2 verification).
signedEvent, err := aep.SignEventV1(event, secret)
// or, equivalently:
signedEvent, err = aep.SignEventWithCanon(event, secret, "v1")
```

`VerifySignature` is version-aware and backward-compatible: a `"v2"` marker is
verified against the deep form only, `"v1"` against the shallow form only, and an
**absent** marker is accepted if it matches *either* form (transition mode). The
digest is **base64**-encoded in both versions, byte-identical to the server, Node,
and Python SDKs (locked by a cross-language known-answer test).

> **Default flip (issue #59):** `SignEvent` now defaults to **v2** (was v1), so new
> signatures cover nested payloads by default. Use `SignEventV1` for the legacy
> envelope-only form. A v2-default emitter requires a v2-aware server (server
> PR #60+); the server still accepts v1 during the transition, so `SignEventV1`
> remains available for legacy servers. Hard-retiring v1 (server requiring v2) is a
> separate future change tracked in issue #59.

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

## Releasing (publishing)

Unlike npm or PyPI, **Go has no registry upload and no publish token.** A module
is "published" simply by pushing a Git **tag**; the public Go module proxy
(`proxy.golang.org`) and checksum database fetch the source from GitHub on demand
the first time someone runs `go get`. There is intentionally **no credential or
publish step** in CI.

Because this SDK is a subdirectory module (its `go.mod` lives at `sdks/go/`, not
at the repo root), Go's [module-in-subdirectory tag convention][subdir] applies:
the version tag must be **prefixed with the module's subdirectory path**.

To cut a release:

```bash
# 1. Make sure the release commit is merged to main (tags are NOT branch-protected —
#    only ever tag a commit that already landed on main via PR).
git checkout main && git pull

# 2. Tag with the sdks/go/ prefix + semver, then push the tag.
git tag sdks/go/v0.3.0
git push origin sdks/go/v0.3.0
```

Consumers then resolve it as:

```bash
go get github.com/surpradhan/agent-event-protocol/sdks/go@v0.3.0   # exact version
go get github.com/surpradhan/agent-event-protocol/sdks/go@latest   # newest tag via the proxy
```

> **Tag convention vs. version query:** the *Git tag* you push is
> `sdks/go/vMAJOR.MINOR.PATCH` (e.g. `sdks/go/v0.3.0`) — the subdirectory prefix
> is **required**; a bare `v0.3.0` tag would be read as a version of a *root*
> module and would not resolve for this subdirectory module. The *version query*
> consumers type is the **bare** semver `@v0.3.0` (Go maps it to the prefixed tag
> for you, and that bare form is what appears in their `go.mod`). `@latest`
> resolves to the highest `sdks/go/v*` semver tag via the proxy.

`v0.3.0` is the **first real tag** for this module — earlier in-tree code was only
ever consumable via a local `replace` directive (the previous module path,
`github.com/surpradhan/aep-go`, pointed at a repository that does not exist), so
there are no prior published versions to be backward-compatible with.

An optional `Release Go SDK` GitHub Actions workflow (`.github/workflows/release-go-sdk.yml`)
runs on `sdks/go/v*` tag pushes as a **smoke gate** — it verifies the tag is an
ancestor of `origin/main` and runs `go build ./... && go test ./...`. It does
**not** publish anything (Go has no publish step); it just fails loudly if a tag
is cut from unreviewed code or doesn't build. It is tag-triggered only and is not
a required PR check.

[subdir]: https://go.dev/ref/mod#vcs-version

## License

MIT
