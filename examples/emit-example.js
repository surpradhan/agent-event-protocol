const { createEvent } = require("../src/createEvent");

async function main() {
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
  const apiKey = process.env.AEP_API_KEY;

  const event = createEvent({
    source: "agent://example-emitter",
    type: "tool.called",
    session_id: "ses_demo_001",
    trace_id: "trc_demo_001",
    schema: "aep.tool.called/1",
    payload: {
      tool_name: "search",
      arguments: { q: "aep mvp" }
    }
  });

  const headers = { "content-type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(event)
  });

  const body = await response.json();
  console.log(JSON.stringify({ status: response.status, body }, null, 2));

  // Ingest always requires a write-scoped API key — there is no keyless dev
  // bypass for POST /events. Make the failure actionable instead of silent.
  //   401 → no/invalid key supplied
  //   403 → key is valid but lacks the "write" scope
  if (response.status === 401 || response.status === 403) {
    const reason =
      response.status === 403
        ? "the supplied API key lacks the \"write\" scope."
        : "no valid API key was supplied.";
    console.error(
      `\nIngest rejected the request: ${reason}\n` +
        "Set AEP_API_KEY to a write-scoped key, then re-run:\n" +
        "  export AEP_API_KEY=aep_...\n" +
        "  npm run emit:example\n" +
        "See SETUP.md § \"Step 3: Provision an API key\" for how to mint one."
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
