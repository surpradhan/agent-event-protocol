# AEP Python SDK

Python client library for the [Agent Event Protocol](https://github.com/surpradhan/agent-event-protocol#readme) — an observability framework for agent workflows.

**Version:** 0.4.1 · **Python:** ≥ 3.10 · **Schema:** AEP v0.2.0

---

## Installation

From PyPI:

```bash
pip install agent-event-protocol
```

> The PyPI **distribution** name is `agent-event-protocol` (the bare `aep` name
> was already taken on PyPI), but the **import** name is unchanged — you still
> write `import aep`.

From the repo root (development):

```bash
pip install -e "sdks/python[dev]"
```

---

## Quick start

```python
from aep import create_event, AEPClient

# Build a spec-compliant event
event = create_event(
    source="agent://my-agent",
    type="task.created",
    session_id="ses_001",
    trace_id="trc_001",
    payload={"task": "summarise document"},
)

# Emit to the AEP ingest server
with AEPClient(server_url="http://localhost:8787", api_key="aep_...") as client:
    result = client.emit(event)
    # {"accepted": True, "duplicate": False, "id": "evt_..."}
```

Environment variables are read automatically:

| Variable | Purpose | Default |
|----------|---------|---------|
| `AEP_INGEST_URL` | Server base URL | `http://localhost:8787` |
| `AEP_API_KEY` | Bearer token | — |

---

## Async client

```python
import asyncio
from aep import create_event, AsyncAEPClient

async def main():
    event = create_event(
        source="agent://my-agent",
        type="task.completed",
        session_id="ses_001",
        trace_id="trc_001",
        payload={"result": "done"},
    )
    async with AsyncAEPClient() as client:
        result = await client.emit(event)

asyncio.run(main())
```

---

## Event types

```python
from aep import CORE_EVENT_TYPES, EventType

# String constants
print(CORE_EVENT_TYPES)
# ['task.created', 'task.updated', ..., 'error.raised']

# Enum access
EventType.TOOL_CALLED.value  # 'tool.called'
```

The 12 core types: `task.created`, `task.updated`, `task.completed`, `task.failed`,
`tool.called`, `tool.result`, `memory.read`, `memory.write`,
`handoff.started`, `handoff.completed`, `policy.blocked`, `error.raised`.

---

## Multi-agent / sub-agent workflows

```python
from aep import create_event, AEPClient

trace_id = "trc_workflow_001"
orch_session = "ses_orchestrator_001"
sub_session = "ses_subagent_001"

orch_event = create_event(
    source="agent://orchestrator",
    type="task.created",
    session_id=orch_session,
    trace_id=trace_id,
    payload={"goal": "research AI observability"},
    agent_role="orchestrator",
)

sub_event = create_event(
    source="agent://subagent",
    type="task.created",
    session_id=sub_session,
    trace_id=trace_id,       # same trace_id ties sessions together
    parent_session_id=orch_session,  # links to parent
    payload={"subtask": "web search"},
    agent_role="subagent",
)

with AEPClient() as client:
    client.emit_batch([orch_event, sub_event])
    tree = client.get_session_tree(orch_session)
    workflow = client.get_workflow(trace_id)
```

---

## Auto-instrumentation (LangGraph, CrewAI, AutoGen, OpenAI Agents SDK & Claude Agent SDK)

Emit the full multi-agent DAG from a [LangGraph](https://langchain-ai.github.io/langgraph/),
[CrewAI](https://docs.crewai.com/), [AutoGen AgentChat](https://microsoft.github.io/autogen/),
[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/),
or [Anthropic Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
workflow with **no changes to your code** — one `aep.instrument()` call wires AEP
events to the run, every sub-agent, each tool call, and the handoffs between them.
Only the frameworks you actually use need be installed; instrumenting CrewAI,
AutoGen, the OpenAI Agents SDK, or the Claude Agent SDK does **not** require LangChain.

```bash
pip install -e "sdks/python[langgraph]"   # adds langgraph + langchain-core
```

```python
import aep
aep.instrument()          # reads AEP_INGEST_URL / AEP_API_KEY (or pass them in)

# ... build and run your StateGraph exactly as usual ...
app = graph.compile()
app.invoke({"topic": "AI agent observability"})

aep.flush()               # block until buffered telemetry is sent (see below)
# aep.uninstrument()      # optional: restore original behavior (also flushes)
```

What gets emitted, with causation preserved (`trace_id`, `session_id`,
`parent_session_id`, `causation_id`):

| LangGraph event            | AEP event(s)                              | Role          |
|----------------------------|-------------------------------------------|---------------|
| graph run (root)           | `task.created` → `task.completed`/`failed`| orchestrator  |
| node run                   | `task.created` → `task.completed`/`failed`| subagent      |
| orchestrator → node        | `handoff.started` → `handoff.completed`   | orchestrator  |
| tool call                  | `tool.called` → `tool.result`             | (caller)      |
| tool / node error          | `error.raised` / `task.failed`            | (caller)      |

Notes:
- **Tested against `langgraph>=0.1`.** Internals vary across versions; if the
  expected hook isn't found, `instrument()` logs a warning and is a no-op — it
  never crashes your app, and it won't falsely report success.
- Configuration: `aep.instrument(server_url=..., api_key=...)`, or
  `AEP_INGEST_URL` / `AEP_API_KEY` env vars.
- Implemented as a LangChain `BaseCallbackHandler` injected via `RunnableConfig`
  (the supported extension point), so it survives parallel node fan-out.
- **Emission is non-blocking** — events are sent on a background worker so they
  never add network latency to your graph. Call `aep.flush()` before a
  short-lived process exits (or rely on the atexit flush / `uninstrument()`) to
  be sure they were delivered. The buffer is bounded and drops with a warning
  under sustained overload rather than blocking your workflow.
- See `demos/langgraph_multiagent.py` for a runnable 10-node example.

### CrewAI

```bash
pip install -e "sdks/python[crewai]"   # adds crewai (no LangChain needed)
```

```python
import aep
aep.instrument()          # or aep.instrument(frameworks=["crewai"])

# ... build and kick off your Crew exactly as usual ...
crew.kickoff()

aep.flush()
```

| CrewAI event                     | AEP event(s)                              | Role          |
|----------------------------------|-------------------------------------------|---------------|
| `Crew.kickoff()` (root)          | `task.created` → `task.completed`/`failed`| orchestrator  |
| each task (named for its agent)  | `task.created` → `task.completed`/`failed`| subagent      |
| crew → agent dispatch            | `handoff.started` → `handoff.completed`   | orchestrator  |
| tool usage                       | `tool.called` → `tool.result`             | (agent)       |
| tool failure                     | `error.raised`                            | (agent)       |

Notes:
- **Tested against `crewai>=1.0`.** Implemented by subscribing to CrewAI's own
  event bus (`crewai.events`), the supported extension point — not by wrapping
  `Crew`/`Agent` internals. If the event API has drifted, `instrument()` warns and
  is a no-op (never crashes your app).
- CrewAI runs each task through its assigned agent, so a **task** is the
  sub-agent session (named for that agent's role); an agent that runs outside any
  task (e.g. a hierarchical manager) gets its own sub-agent session.
- Tool-call attribution is exact for sequential crews; with **concurrent agents
  running tools at once**, pairing a `tool.result` to its `tool.called` is
  best-effort (the events don't always carry a per-call id).
- See `demos/crewai_multiagent.py` for a runnable 3-agent example that works
  offline with no LLM API key.

### AutoGen AgentChat

```bash
pip install -e "sdks/python[autogen]"   # adds autogen-agentchat + autogen-ext (no LangChain needed)
```

```python
import aep
aep.instrument()          # or aep.instrument(frameworks=["autogen"])

# ... build and run your team exactly as usual ...
await team.run(task="research and write a report")   # or team.run_stream(...)

aep.flush()
```

| AutoGen event                          | AEP event(s)                              | Role          |
|----------------------------------------|-------------------------------------------|---------------|
| team `run` / `run_stream` (root)       | `task.created` → `task.completed`/`failed`| orchestrator  |
| each agent (by message `source`)       | `task.created` → `task.completed`         | subagent      |
| team → agent dispatch                  | `handoff.started` → `handoff.completed`   | orchestrator  |
| `ToolCallRequestEvent` → `…ExecutionEvent` | `tool.called` → `tool.result`         | (agent)       |
| tool execution error (`is_error`)      | `error.raised`                            | (agent)       |

Notes:
- **Tested against `autogen-agentchat>=0.4`** (developed on 0.7.x). AutoGen
  AgentChat has no callback registry or event bus, so the tracer taps the async
  event stream `BaseGroupChat.run_stream` yields (which `team.run()` consumes
  internally — so both entry points are covered). If the team base class has
  drifted, `instrument()` warns and is a no-op (never crashes your app).
- **Teams are the instrumented surface.** A team is the orchestrator; each agent
  that speaks becomes a sub-agent session. In-team agents run through the AgentChat
  runtime, so they're captured once with no double-counting. A standalone single
  `AssistantAgent` run with no team is not instrumented — wrap it in a team.
- **Tool pairing is exact**, even for parallel tool calls returned out of order:
  AutoGen tags each result with the `call_id` of its request, so no LIFO guessing
  is needed (unlike CrewAI).
- Agent boundaries are inferred from message `source` (AutoGen emits no per-agent
  start/stop event), so a run-level failure marks only the orchestrator
  `task.failed`; observed sub-agents close `task.completed`.
- See `demos/autogen_multiagent.py` for a runnable 2-agent team example that works
  offline with no LLM API key (via `autogen-ext`'s `ReplayChatCompletionClient`).

### OpenAI Agents SDK

```bash
pip install -e "sdks/python[openai-agents]"   # adds openai-agents (no LangChain needed)
```

```python
import aep
aep.instrument()          # or aep.instrument(frameworks=["openai-agents"])

# ... build and run your agents exactly as usual ...
from agents import Runner
await Runner.run(triage_agent, "help me in Spanish")   # or Runner.run_sync(...)

aep.flush()
```

| OpenAI Agents SDK trace/span             | AEP event(s)                              | Role          |
|------------------------------------------|-------------------------------------------|---------------|
| `Runner.run` trace (root)                | `task.created` → `task.completed`         | orchestrator  |
| `agent` span                             | `task.created` → `task.completed`/`failed`| subagent      |
| workflow → agent dispatch                | `handoff.started` → `handoff.completed`   | orchestrator  |
| `function` span                          | `tool.called` → `tool.result`             | (agent)       |
| `function` span error (`span.error`)     | `error.raised`                            | (agent)       |

Notes:
- **Tested against `openai-agents>=0.1`** (developed on 0.17.x). Implemented by
  registering a tracing processor via `agents.tracing.add_trace_processor` — the
  SDK's supported, global, zero-code observation surface — *alongside* (not
  replacing) the SDK's own exporter. If the tracing API has drifted,
  `instrument()` warns and is a no-op (never crashes your app).
- **The run's trace is the orchestrator**, and every agent is a sub-agent of it —
  matching how the SDK itself trees agents as siblings under the workflow. The
  real `from_agent` of a handoff is recorded on the handed-to agent's
  `task.created` payload as `handoff_from`, so the actual flow is preserved even
  though the parent edge is the workflow root.
- **Tool pairing is exact**: a tool is a single `function` span carrying both its
  start and end, so `tool.called` → `tool.result` pair by `span_id` — no LIFO
  guessing. A tool nests on its owning agent's session (resolved by walking the
  span tree to the nearest enclosing agent).
- **Agents-as-tools** (`agent.as_tool(...)`) produce **both** a `tool.called` /
  `tool.result` pair (for the `as_tool` function span) **and** a nested sub-agent
  `task.*` for the inner agent (parented to the calling agent) — a faithful
  double-representation of "the outer agent called a tool that was itself an
  agent", not a duplicate. The DAG stays a single trace with no dangling links.
- **Caveat — uncaught run errors aren't marked failed.** The tracing surface only
  reports failures the SDK records on a span (e.g. a tool error). An *uncaught*
  exception from `Runner.run` is not delivered to processors — the spans and
  trace still close cleanly and the exception propagates to your caller — so such
  a run is recorded `completed` here. The exception itself remains your source of
  truth; AEP deliberately doesn't add a separate failure path that would race the
  SDK's own span/trace close.
- **Guardrail tripwires are not yet mapped** to `policy.blocked` (future work).
- See `demos/openai_agents_multiagent.py` for a runnable handoff + tool example
  that works offline with no LLM API key (via a scripted `Model`).

### Anthropic Claude Agent SDK

```bash
pip install -e "sdks/python[claude-agent]"   # adds claude-agent-sdk (no LangChain needed)
```

```python
import aep
aep.instrument()          # or aep.instrument(frameworks=["claude-agent"])

# ... run your agent exactly as usual ...
from claude_agent_sdk import query
async for message in query(prompt="review the repo"):   # or ClaudeSDKClient(...)
    ...

aep.flush()
```

| Claude Agent SDK hook                    | AEP event(s)                              | Role          |
|------------------------------------------|-------------------------------------------|---------------|
| top-level agent (per `session_id`)       | `task.created` → `task.completed`         | orchestrator  |
| `SubagentStart` / `SubagentStop`         | `task.created` / `task.completed`         | subagent      |
| top-level → sub-agent (Task)             | `handoff.started` → `handoff.completed`   | orchestrator  |
| `PreToolUse` → `PostToolUse`             | `tool.called` → `tool.result`             | (agent)       |
| `PostToolUseFailure`                     | `error.raised`                            | (agent)       |

Notes:
- **Tested against `claude-agent-sdk>=0.2`** (developed on 0.2.x). Implemented by
  injecting observer hooks into `ClaudeAgentOptions.hooks` — the SDK's supported
  observation surface — at the two methods both entry points consume
  (`InternalClient.process_query` for `query()`, `ClaudeSDKClient.connect` for the
  streaming client). If the hooks API has drifted, `instrument()` warns and is a
  no-op (never crashes your app). Call `aep.instrument()` once at startup.
- **The top-level agent is the orchestrator** (one per `session_id`); each `Task`
  sub-agent is a sub-agent of it. Every tool/sub-agent hook carries an `agent_id`
  and `tool_use_id`, so attribution and pairing are **exact** — a tool nests on
  its owning agent's session (the sub-agent named by `agent_id` if one is open,
  else the root), and `tool.called`/`tool.result` pair by `tool_use_id`. No
  inference, no LIFO guessing.
- **The injected hooks are pure observers** — each returns `{}` (proceed, no
  decision) and swallows its own errors, so AEP can never alter or break your
  agent run. They coexist with any hooks you configure yourself.
- **Caveat — the top-level run is closed by the `Stop` hook** (fired at the end of
  each turn). A multi-turn `ClaudeSDKClient` session therefore records one trace
  per turn (the root reopens on the next turn's first hook). Sub-agents still
  open/close within their turn.
- See `demos/claude_agent_multiagent.py` for a runnable orchestrator + sub-agent +
  tools example that works **offline with no API key and no `claude` binary** (it
  replays scripted hooks through a real `query()` via a control-protocol fake
  transport).

---

## Client API

### `AEPClient` (sync) / `AsyncAEPClient` (async)

| Method | `AEPClient` (sync) | `AsyncAEPClient` (async) |
|--------|--------------------|--------------------------|
| `emit(event)` | POST `/events` — returns response body | same, `await`-able |
| `emit_batch(events)` | Sequential; raises on first error, prior events already sent | Concurrent (`asyncio.gather`); all complete before raising |
| `get_sessions(*, limit, cursor)` | GET `/sessions` — paginated list | same, `await`-able |
| `get_session_events(session_id, *, type, q, limit, cursor)` | GET `/sessions/{id}/events` | same, `await`-able |
| `get_session_tree(session_id)` | GET `/sessions/{id}/tree` | same, `await`-able |
| `get_session_export(session_id, *, format)` | GET `/sessions/{id}/export` | same, `await`-able |
| `get_workflow(trace_id)` | GET `/workflows/{traceId}` | same, `await`-able |
| `get_metrics()` | GET `/metrics` | same, `await`-able |
| `health()` | GET `/health` | same, `await`-able |
| `ready()` | GET `/ready` | same, `await`-able |

---

## HMAC signing

```python
from aep import create_event, sign_event

event = create_event(source="agent://test", type="task.created",
                     session_id="ses_1", trace_id="trc_1", payload={})
sign_event(event, secret="my-hmac-secret")  # v2 (deep) by default
# event["signature"] == {"alg": "hmac-sha256", "value": "<base64>", "canon": "v2"}

# Or let the client sign automatically:
from aep import AEPClient
with AEPClient(hmac_secret="my-hmac-secret") as client:
    client.emit(event)  # signs (v2) before sending
```

### Canonicalization versions (`canon`) — issue #59

The default canonical form is now **v2** (deep): it recursively key-sorts the
whole event including nested payloads, so the signature covers payload contents
and carries a `signature.canon: "v2"` marker — payload tamper-evidence is on
without opt-in. `canonicalize_v2(event)` exposes the deep form directly. It is
**byte-identical to the server and the Node and Go SDKs** for JSON values shared
across runtimes (locked by a server-derived known-answer test).

**v1 is now legacy** but still supported — pass `canon="v1"` for the
envelope-only form, which sorts only top-level keys and drops nested object
contents (covers the envelope but **not nested payloads**):

```python
sign_event(event, secret="my-hmac-secret", canon="v1")  # legacy envelope-only
```

`verify_signature` is version-aware (honours `canon`; an absent marker accepts
either form).

> **Compatibility:** the v2 default requires a v2-aware server (one that includes
> server PR #60+). The current AEP server **requires v2 and rejects legacy v1**
> with `401` — the v1 retirement is complete
> ([issue #65](https://github.com/surpradhan/agent-event-protocol/issues/65),
> the successor to the [#59](https://github.com/surpradhan/agent-event-protocol/issues/59)
> unification). `canon="v1"` is retained only for talking to an **older
> self-hosted server** that predates `signature.canon` support; a current server
> rejects it.

---

## Validation

```python
from aep import create_event, validate_event

event = create_event(...)
result = validate_event(event)
# {"valid": True, "errors": []}

# Errors include warnings prefixed with [warn] which don't affect validity
```

---

## Exceptions

| Exception | When raised |
|-----------|-------------|
| `AEPValidationError` | HTTP 400 — schema validation failed; has `.errors: list[str]` |
| `AEPAuthError` | HTTP 401/403 — bad API key or insufficient scope |
| `AEPRateLimitError` | HTTP 429 — rate limit hit; has `.retry_after: int` |
| `AEPNotFoundError` | HTTP 404 — session or workflow not found |
| `AEPServerError` | HTTP 5xx — server-side error; has `.status_code: int` |
| `AEPConnectionError` | Network error reaching the server |

---

## Demo

A complete multi-agent research demo is in [`demos/subagent_research.py`](https://github.com/surpradhan/agent-event-protocol/blob/main/sdks/python/demos/subagent_research.py).
It mirrors the JS demo and exercises the session tree and workflow APIs.

```bash
# Start the server first
npm run ingest   # from repo root

# Run the demo
cd sdks/python
python demos/subagent_research.py
```

---

## Tests

```bash
cd sdks/python
pip install -e ".[dev]"

# Unit tests (no server needed)
pytest tests/unit/

# Integration tests (requires running server)
AEP_INGEST_URL=http://localhost:8787 pytest tests/integration/
```

---

## Publishing / Releases

The SDK is published to PyPI as **`agent-event-protocol`** (import name stays `aep`) by
the [`Release Python SDK`](https://github.com/surpradhan/agent-event-protocol/blob/main/.github/workflows/release-python-sdk.yml)
workflow, which is triggered **only** by pushing a `python-sdk-v*` tag — never on
a branch push or PR. Publishing uses **PyPI Trusted Publishing (OIDC)**, so there
is no API token to store or leak.

Like tags in general, `python-sdk-v*` tags are **not** branch-protected, so the
release is gated twice and independently:

1. **`verify`** — fails fast unless the tagged commit is an ancestor of
   `origin/main` (i.e. it landed via the PR-protected merge path), then builds the
   sdist + wheel and runs `pytest`. The approver sees a green pre-flight.
2. **`publish`** — runs in the `pypi-publish` GitHub Environment, which has
   **required reviewers**. The upload to PyPI only happens after a human approves
   the deployment, and it ships the exact artifacts `verify` built and tested.

### Maintainer setup (one-time)

Before the first release, configure the publisher side (cannot be done from code):

- **PyPI Trusted Publisher** — on PyPI, add a GitHub Actions trusted publisher
  (use the *pending publisher* flow for the first-ever release, since the project
  doesn't exist on PyPI yet) with exactly:
  - Project name: `agent-event-protocol`
  - Owner: `surpradhan` · Repository: `agent-event-protocol`
  - Workflow: `release-python-sdk.yml` · Environment: `pypi-publish`
- **GitHub Environment** — create an Environment named `pypi-publish` under
  Settings → Environments and add the release owners as **Required reviewers**.
  No secrets are stored (OIDC replaces the API token).

### Cutting a release

```bash
# 1. Bump sdks/python/pyproject.toml `version` AND aep/__init__.py `__version__`
#    (keep them in sync) on a PR; squash-merge to main.
# 2. From main, tag the release commit and push the tag:
git tag python-sdk-v0.4.1
git push origin python-sdk-v0.4.1
# 3. Approve the `pypi-publish` deployment in the Actions UI once `verify` is green.
```
