# Versioning

AEP ships several independently-versioned artifacts. They are **not** kept in
lockstep, and their numbers answer different questions. This page is the
single place that reconciles them.

## The artifacts

| Artifact | Where the number lives | Current | What it versions |
|---|---|---|---|
| **Protocol (`specversion`)** | Event envelope (`"specversion": "0.2.0"`), `schemas/` | **0.2.0** | The wire format: envelope fields + the 12 core event types. Changes only when the event shape changes. |
| **HTTP API** | `/v1` path prefix + `API-Version: 1` response header | **v1** | The REST surface. All API routes are also served unversioned at `/` for backward compatibility; app-level endpoints (e.g. `/health`, `/ready`, `/metrics/prometheus`, `/admin/*`, `/dashboard`, `/docs`, `/openapi.json`) are unversioned by design. |
| **Server package** | Root `package.json` | **1.0.0** | The Node.js ingest server + dashboard + CLI codebase. **Not released anywhere** — there is no npm publish or Docker-registry pipeline for the server; it runs from source (or a locally-built image). The number is a package-manifest formality, not a release claim. |
| **Python SDK** | `sdks/python/pyproject.toml` | latest on PyPI as [`agent-event-protocol`](https://pypi.org/project/agent-event-protocol/) (0.4.x at time of writing) | The active, carry-forward SDK — the registry is the authority; this cell is not updated per release. |
| **Node SDK** | `sdks/node/package.json` | **0.4.0** on npm as [`@surpradhan/aep`](https://www.npmjs.com/package/@surpradhan/aep) | Frozen (maintenance mode) per the project direction note in the [README](README.md). |
| **Go SDK** | git tag | **`sdks/go/v0.3.0`** (`go get github.com/surpradhan/agent-event-protocol/sdks/go`) | Frozen (maintenance mode). Nothing is "published" for Go beyond the tag — the module proxy serves the repo. |
| **Audit bundle** | `aep_audit_version` field | **0.1.0** | The signed audit-bundle document format produced by `aep audit export` and the audit-bundle endpoints. |

The in-repo version of an SDK may be **ahead** of the latest published release
while changes await a release tag; PyPI/npm are the source of truth for what
is installable.

## Why they differ (and that's fine)

- The **protocol** is deliberately conservative: 0.2.0 has been stable across
  every server/SDK release since it landed, and cross-language HMAC signing is
  locked to its canonical form.
- The **server's 1.0.0** predates this policy and overstates maturity relative
  to its unreleased status; treat `specversion` and the API version as the
  meaningful compatibility signals, not the server package number.
- **SDK versions** move independently per language, released via tag-triggered
  workflows (`.github/workflows/release-{python,node,go}-sdk.yml`) — with a
  human-approved publish gate for Python and Node, and verification-only for
  Go, where the tag itself is the release (see Release mechanics below).

## Release mechanics

- **Python:** push `python-sdk-vX.Y.Z` → verify job (tag must be on `main`) →
  human-gated PyPI Trusted Publishing (OIDC).
- **Node:** push `node-sdk-vX.Y.Z` → same gate → `npm publish --provenance`.
- **Go:** push `sdks/go/vX.Y.Z` — the tag *is* the release (smoke-gate workflow
  only; consumers fetch via the Go module proxy).
- **Server / operator / otelbridge:** no release pipeline exists. Run from
  source. (Deliberate under the OpenTelemetry-convergence direction noted in
  the [README](README.md) — the server is a reference implementation, not a
  distributed product.)
