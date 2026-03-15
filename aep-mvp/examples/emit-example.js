const { createEvent } = require("../src/createEvent");

async function main() {
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";

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

  const response = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  });

  const body = await response.json();
  console.log(JSON.stringify({ status: response.status, body }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
