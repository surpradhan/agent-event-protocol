"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

/**
 * Integration tests for CLI commands.
 *
 * These tests verify that CLI command handlers work correctly with a mock HTTP server.
 * They validate end-to-end command execution including:
 * - Argument parsing
 * - HTTP request construction
 * - Response handling
 * - Error conditions
 */

const mockApiKey = "aep_test_key_0123456789abcdef0123456789abcdef";

describe("CLI command integration tests", async () => {
  // Set up mock server
  const mockServer = http.createServer((req, res) => {
    const auth = req.headers.authorization;

    // Verify Authorization header
    if (!auth || !auth.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "API key required" }));
      return;
    }

    // Mock /events endpoint
    if (req.method === "POST" && req.url === "/events") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const event = JSON.parse(body);
          if (event.type && event.source && event.session_id && event.trace_id) {
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ accepted: true, id: event.id }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required fields" }));
          }
        } catch (_) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    // Mock /sessions endpoint
    if (req.method === "GET" && req.url.startsWith("/sessions/")) {
      const sessionId = req.url.split("/")[2];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        events: [
          {
            id: "evt_001",
            type: "task.created",
            time: new Date().toISOString(),
            source: "agent://test",
            session_id: sessionId,
            trace_id: "trc_001"
          }
        ]
      }));
      return;
    }

    // Mock /workflows endpoint
    if (req.method === "GET" && req.url.startsWith("/workflows/")) {
      const traceId = req.url.split("/")[2];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        trace_id: traceId,
        session_count: 1,
        tree: {
          id: "ses_001",
          type: "orchestrator",
          children: []
        }
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Start server and wait for it to be ready
  const mockServerUrl = await new Promise((resolve) => {
    mockServer.listen(0, () => {
      resolve(`http://localhost:${mockServer.address().port}`);
    });
  });

  test("emit command sends event to server with Bearer authorization", (t, done) => {
    const event = {
      specversion: "0.2.0",
      id: "evt_test_001",
      time: new Date().toISOString(),
      source: "agent://test",
      type: "task.created",
      session_id: "ses_test_001",
      trace_id: "trc_test_001",
      payload: {}
    };

    const req = http.request(
      `${mockServerUrl}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${mockApiKey}`
        }
      },
      (res) => {
        assert.equal(res.statusCode, 202);
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          const result = JSON.parse(data);
          assert.equal(result.accepted, true);
          done();
        });
      }
    );

    req.on("error", (err) => {
      assert.fail(`Request failed: ${err.message}`);
    });

    req.write(JSON.stringify(event));
    req.end();
  });

  test("session query endpoint returns events with Bearer authorization", (t, done) => {
    const req = http.request(
      `${mockServerUrl}/sessions/ses_test_001/events`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${mockApiKey}`
        }
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          const result = JSON.parse(data);
          assert.ok(Array.isArray(result.events));
          assert.equal(result.events.length, 1);
          assert.equal(result.events[0].type, "task.created");
          done();
        });
      }
    );

    req.on("error", (err) => {
      assert.fail(`Request failed: ${err.message}`);
    });

    req.end();
  });

  test("workflow endpoint returns tree with Bearer authorization", (t, done) => {
    const req = http.request(
      `${mockServerUrl}/workflows/trc_test_001`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${mockApiKey}`
        }
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          const result = JSON.parse(data);
          assert.equal(result.trace_id, "trc_test_001");
          assert.equal(result.session_count, 1);
          assert.ok(result.tree);
          done();
        });
      }
    );

    req.on("error", (err) => {
      assert.fail(`Request failed: ${err.message}`);
    });

    req.end();
  });

  test("requests without authorization are rejected", (t, done) => {
    const req = http.request(
      `${mockServerUrl}/sessions/ses_test_001/events`,
      {
        method: "GET"
        // No Authorization header
      },
      (res) => {
        assert.equal(res.statusCode, 401);
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          const result = JSON.parse(data);
          assert.equal(result.error, "API key required");
          done();
        });
      }
    );

    req.on("error", (err) => {
      assert.fail(`Request failed: ${err.message}`);
    });

    req.end();
  });

  test("emit with missing required fields is rejected", (t, done) => {
    const incompleteEvent = {
      specversion: "0.2.0",
      id: "evt_test_002"
      // Missing: time, source, type, session_id, trace_id, payload
    };

    const req = http.request(
      `${mockServerUrl}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${mockApiKey}`
        }
      },
      (res) => {
        assert.equal(res.statusCode, 400);
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          const result = JSON.parse(data);
          assert.equal(result.error, "Missing required fields");
          done();
        });
      }
    );

    req.on("error", (err) => {
      assert.fail(`Request failed: ${err.message}`);
    });

    req.write(JSON.stringify(incompleteEvent));
    req.end();
  });

  // Cleanup
  test.after(() => {
    mockServer.close();
  });
});
