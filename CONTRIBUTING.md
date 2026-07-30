# Contributing to Agent Event Protocol

Thank you for your interest in contributing to AEP! We welcome contributions from everyone: whether it's bug fixes, features, documentation, or ideas.

> **📍 Project direction (2026-06):** AEP is converging on OpenTelemetry rather than continuing as a standalone protocol. **Feature contributions are welcome for the Python SDK (`sdks/python/`) and the OTel bridge (`otelbridge/`)** — the active surfaces carrying this work forward. The ingest server, dashboard, and Kubernetes operator are **parked** (reference implementation — bugfixes and docs welcome, not new features), and the Go and Node SDKs are **frozen** (maintenance mode only, don't extend them). See the project direction note at the top of [README.md](./README.md) for the full picture.

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- npm 10+
- Git
- Basic understanding of Express.js and SQLite

### Development Setup

```bash
# 1. Fork the repository on GitHub
# 2. Clone your fork
git clone https://github.com/YOUR-USERNAME/agent-event-protocol.git
cd agent-event-protocol

# 3. Add upstream remote
git remote add upstream https://github.com/surpradhan/agent-event-protocol.git

# 4. Install dependencies
npm install

# 5. Start development server
npm run dev
```

### Running Tests & Linting

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:unit -- --watch

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix
```

---

## 📝 Development Workflow

### 1. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-number-brief-description
```

**Branch naming conventions:**
- `feature/`: new features
- `fix/`: bug fixes
- `docs/`: documentation
- `refactor/`: code improvements
- `test/`: test additions

### 2. Make Your Changes

- Keep commits atomic and focused
- Write clear commit messages (see below)
- Add tests for new functionality
- Update documentation if needed

### 3. Commit Message Format

```
type(scope): subject

body (optional)

footer (optional)
```

**Examples:**
```
feat(cli): add --dry-run flag to emit command
fix(auth): prevent race condition in token validation
docs(readme): clarify multi-tenant setup
test(validation): add edge case tests for event schema
refactor(db): simplify query builder
```

**Types:**
- `feat`: new feature
- `fix`: bug fix
- `docs`: documentation
- `test`: tests
- `refactor`: code refactoring
- `perf`: performance improvement
- `style`: code style (formatting, semicolons, etc.)
- `chore`: dependencies, build, CI/CD

### 4. Push & Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then open a PR on GitHub with a clear title and description.

### Branch protection on `main`

`main` is a protected branch — you can't push to it directly. **All changes land through a pull request**, and the following must be satisfied before merge:

- **CI is green.** Every required status check must pass. The list below is kept in lock-step with the CI workflow by the `Required checks in sync` job (it fails the build if this list, the CI jobs, or branch protection drift apart), so edit it in the same PR whenever you add or rename a CI job:
  <!-- required-checks:start -->
  - `Operator unit tests`
  - `Go SDK unit tests`
  - `otelbridge unit tests`
  - `Python SDK tests (3.10)`
  - `Python SDK tests (3.11)`
  - `Python SDK tests (3.12)`
  - `Python SDK tests (3.13)`
  - `Node SDK tests (20.x)`
  - `Node SDK tests (22.x)`
  - `test (20.x)`
  - `Postgres parity tests`
  - `build`
  - `docker`
  - `Required checks in sync`
  <!-- required-checks:end -->
- **Branch is up to date with `main`.** If `main` moved ahead, rebase/merge it in and let CI re-run (`git fetch upstream && git rebase upstream/main`).
- **All review conversations are resolved.**
- **Linear history.** We squash-merge, so no merge commits — keep your branch rebased rather than merging `main` back in repeatedly if you can.

A review approval is **not** currently required to merge, but a maintainer still reviews every PR. Force-pushes to `main` and branch deletion are disabled, and these rules apply to maintainers too.

### Releasing the Node SDK

The npm release of `@surpradhan/aep` is gated to the same standard as merging to `main`. Pushing a `node-sdk-v*` tag triggers the [`Release Node SDK`](.github/workflows/release-node-sdk.yml) workflow, which:

1. **Verifies the tag is on reviewed code** — the `verify` job fails fast unless the tagged commit is an ancestor of `origin/main`, so a tag cut from an unreviewed or off-`main` commit can never publish.
2. **Requires a human approval to publish** — the `publish` job runs in the `npm-publish` deployment environment (required reviewers), and `npm publish` only runs after a maintainer approves the deployment. `NPM_TOKEN` is an *environment* secret on `npm-publish`, so it is only exposed to that gated job.

This is intentionally a release workflow, **not** a required PR status check, so it is not part of the required-checks list above and the drift-guard does not track it. See `sdks/node/README.md` → *Publishing / Releases* for the full flow and the one-time maintainer environment setup.

---

## ✅ Pull Request Checklist

Before submitting a PR, ensure:

- [ ] Code follows project style (run `npm run lint:fix`)
- [ ] Tests pass (`npm test`)
- [ ] New tests added for new functionality
- [ ] Documentation updated (README, JSDoc, etc.)
- [ ] Commit messages follow the format above
- [ ] Branch is up to date with `main`
- [ ] No breaking changes (or clearly documented)

**PR Title Format:**
```
[type] Short description

Example:
[feat] Add --format flag to export command
[fix] Resolve race condition in SSE connection limiting
[docs] Update contributing guidelines
```

**PR Description Template:**
```markdown
## What does this PR do?
Brief description of the changes.

## Why?
Explain the motivation behind the change.

## How to test?
Step-by-step instructions or demo commands.

## Screenshots / Demos (if applicable)
Add screenshots, GIFs, or dashboards showing the change.

## Related Issues
Closes #123
Related to #456

## Checklist
- [ ] Tests pass
- [ ] Documentation updated
- [ ] No breaking changes
```

---

## 🎯 Areas We're Looking For Help

For the current roadmap and open work items, see the [Roadmap section in README.md](./README.md#-roadmap). The Good First Issues list below is current as of the last doc update — check the GitHub issue tracker for the freshest picture.

### Good First Issues (For New Contributors)
Look for issues tagged with `good-first-issue` label on GitHub:
- Documentation improvements (README, API docs, examples)
- Error message clarity (making error messages more helpful)
- Test coverage gaps (adding tests for uncovered code paths)
- Example scenarios (creating new demo scripts)
- TypeScript definitions (adding .d.ts types for public API)

---

## 🏗️ Architecture Overview

### Key Files
```
agent-event-protocol/
├── src/
│   ├── server.js            # Express app; v1 router mounted at / and /v1
│   ├── cli.js               # `aep` CLI entry point
│   ├── cli-validate.js      # CLI event-file validation helper
│   ├── auth.js              # API keys (hashed), DASHBOARD_TOKEN, ADMIN_TOKEN
│   ├── errors.js            # Shared CLI error rendering (describeError, targetOf)
│   ├── validator.js         # Event schema validation (AJV)
│   ├── createEvent.js       # Event factory
│   ├── coreEventTypes.js    # The 12 core event type constants
│   ├── signature.js         # HMAC signing/verification
│   ├── _canonical.js        # Canonical JSON form used for signing
│   ├── customQuery.js       # Safe structured analytics queries
│   ├── analytics.js         # Policy/performance/anomaly analytics endpoints
│   ├── anomalies.js         # Robust modified-z anomaly detection
│   ├── performance.js       # Latency percentile analytics
│   ├── workflowGraph.js     # Causation-graph / DAG endpoint
│   ├── audit.js             # HMAC-signed audit bundle export
│   ├── audit-pdf.js         # Audit bundle PDF rendering
│   ├── compliance.js        # SOC2/HIPAA/GDPR/EU-AI-Act compliance reports
│   ├── compliance-pdf.js    # Compliance report PDF rendering
│   ├── retention.js         # Retention pruning logic
│   ├── prune.js             # `npm run prune` CLI
│   ├── export.js            # `npm run export` CLI
│   ├── webhooks.js          # Webhook CRUD
│   ├── webhookDelivery.js   # Webhook delivery + retries
│   ├── webhookSignature.js  # Per-webhook HMAC signing
│   ├── ssrf.js              # SSRF guard for webhook targets
│   ├── metrics.js           # JSON + Prometheus metrics
│   ├── logger.js            # Pino structured logging
│   ├── regions.js           # Data residency labels
│   ├── tiers.js             # Project tiers/quotas
│   ├── openapi.json         # OpenAPI 3.1 spec (source of truth for the API)
│   ├── db/
│   │   ├── index.js          # StorageBackend selection (SQLite/Postgres)
│   │   ├── migrate.js        # Migration runner
│   │   ├── migrations/       # 001..010, one file per schema change
│   │   └── backends/
│   │       ├── interface.js  # StorageBackend interface contract
│   │       ├── sqlite.js     # SQLite backend (better-sqlite3)
│   │       ├── postgres.js   # Postgres backend (hand-mirrored DDL)
│   │       └── _helpers.js   # Shared backend query helpers
│   ├── export/
│   │   ├── index.js          # Streaming export core
│   │   ├── formats.js        # JSONL/CSV/Parquet formatting
│   │   ├── parquet.js        # Parquet writer (lazy-required)
│   │   ├── s3sink.js         # S3 egress
│   │   └── sink.js           # Local-file sink
│   ├── middleware/
│   │   ├── rateLimit.js      # Per-API-key rate limiting (ingest only)
│   │   ├── quota.js          # Per-project quota enforcement
│   │   ├── accessLog.js      # Opt-in, path-only access logging
│   │   └── queryValidation.js # Query-param validation
│   └── public/
│       ├── dashboard.html    # Vanilla-JS dashboard (~3.1k lines)
│       └── fonts/            # Statically served dashboard fonts
├── tests/
│   ├── unit/                # Unit tests
│   └── integration/         # Integration tests
└── examples/                # Demo scenarios
```

### Key Concepts

**Event Flow:**
1. Agent emits event via HTTP POST or CLI
2. Middleware authenticates with API key
3. Validator checks against JSON Schema
4. Deduplicator prevents duplicates
5. HMAC verifier checks signature (if configured)
6. SQLite stores event
7. SSE broadcasts to dashboard in real-time

**Multi-Tenancy:**
- Each API key bound to a `tenant_id`
- All queries scoped to `req.tenant_id`
- Cross-tenant access rejected at middleware

**Testing Strategy:**
- Unit tests validate individual functions
- Integration tests verify HTTP flow
- Fixtures provide valid/invalid event examples

---

## 🐛 Reporting Bugs

When reporting bugs, include:

1. **Description**: What went wrong?
2. **Reproduction steps**: How to reproduce?
3. **Expected behavior**: What should happen?
4. **Actual behavior**: What happened instead?
5. **Environment**: Node version, OS, Docker, etc.
6. **Logs**: Error messages, stack traces

**Example:**
```
Title: Dashboard shows blank events list when filtering by unknown type

Description:
When I filter events by a non-existent event type, the dashboard 
shows an empty list instead of "no events matching filter".

Steps to reproduce:
1. Start server: npm run ingest
2. Emit an event: npm run emit:example
3. Open dashboard: http://localhost:8787/dashboard
4. Filter by type: "unknown.type"
5. See blank area instead of "no results" message

Expected: Show "No events matching filter" message
Actual: Shows blank white area
Environment: Node 20.11, macOS 14.3
```

---

## 💬 Asking Questions

Have questions about the codebase?

1. Check existing [discussions](https://github.com/surpradhan/agent-event-protocol/discussions)
2. Open a [new discussion](https://github.com/surpradhan/agent-event-protocol/discussions/new) with label `question`
3. Read [AUTH.md](./AUTH.md) and [SETUP.md](./SETUP.md) for common topics

---

## 📚 Useful Resources

- **[README.md](./README.md)**: Project overview & quick start
- **[AUTH.md](./AUTH.md)**: Authentication, key management, HMAC signing
- **[CHANGELOG.md](./CHANGELOG.md)**: Version history & breaking changes
- **[SETUP.md](./SETUP.md)**: Detailed installation & troubleshooting
- **[OpenAPI Docs](http://localhost:8787/docs)**: Interactive API reference

---

## 🔄 Code Review Process

All PRs go through:
1. **Automated checks**: Tests pass, linting passes
2. **Maintainer review**: A maintainer reviews every PR and leaves feedback. This isn't a hard GitHub-enforced merge gate — see "Branch protection on `main`" above — but review happens in practice before a PR merges
3. **Feedback integration**: Address comments & re-request review

Maintainers aim to review PRs within 48 hours.

---

## 📋 Code Style

### JavaScript Style Guide
- Use **strict mode** (`"use strict"`)
- Use **const/let** (never var)
- Use **async/await** over promises
- Add **JSDoc comments** for public functions
- Keep functions under 50 lines
- No trailing whitespace

**Example:**
```javascript
/**
 * Validate an event against the AEP schema.
 *
 * @param {object} event - The event to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEvent(event) {
  if (!event || typeof event !== "object") {
    return { valid: false, errors: ["Event must be an object"] };
  }
  // ... validation logic
  return { valid: true, errors: [] };
}
```

### Testing Style
- Use Node.js built-in `node:test` module
- Use `assert/strict` for assertions
- Test both success and failure cases
- Use descriptive test names

```javascript
test("validateEvent rejects null input", () => {
  const result = validateEvent(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});
```

---

## 🎓 Learning Resources

### Understanding AEP
- [Product roadmap](./README.md#-roadmap)
- [Setup guide with examples](./SETUP.md)
- [Demo scenarios](./examples/demos/)

### Technologies Used
- **Express.js**: Web framework
- **SQLite**: Database (better-sqlite3)
- **AJV**: JSON Schema validation
- **Pino**: Structured logging
- **node:test**: Testing framework

---

## 🤝 Community

- **Discussions**: Ideas, questions, announcements
- **Issues**: Bug reports, feature requests
- **Pull Requests**: Code contributions

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

---

## ❤️ Thank You!

We appreciate your contributions, no matter how small. You're helping build better observability for AI agents!

---

**Questions?** Open an [issue](https://github.com/surpradhan/agent-event-protocol/issues) or [discussion](https://github.com/surpradhan/agent-event-protocol/discussions).
