"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Helper to validate events (imported from src/validator)
const { validateEvent } = require("../../src/validator");

// ---------------------------------------------------------------------------
// Helper functions from cli-validate.js (extracted for testing)
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file, handling BOM (Byte Order Mark) characters.
 * BOM is automatically removed before JSON parsing.
 *
 * @param {string} filePath - Path to the JSON file to read
 * @returns {object|array} - Parsed JSON content
 * @throws {Error} - If file cannot be read or JSON is invalid
 */
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  // Remove UTF-8 BOM if present
  const sanitized = raw.replace(/^\uFEFF/, "");
  return JSON.parse(sanitized);
}

// ---------------------------------------------------------------------------
// Tests for readJson helper function
// ---------------------------------------------------------------------------

describe("readJson helper function", () => {
  test("reads valid JSON from file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
    const testFile = path.join(tmpDir, "valid.json");
    const testData = { specversion: "0.2.0", id: "evt_test", type: "task.created" };

    fs.writeFileSync(testFile, JSON.stringify(testData));
    const result = readJson(testFile);

    assert.deepEqual(result, testData);
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  });

  test("reads JSON with BOM (Byte Order Mark)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
    const testFile = path.join(tmpDir, "bom.json");
    const testData = { key: "value" };

    // Write JSON with BOM
    fs.writeFileSync(testFile, "﻿" + JSON.stringify(testData));
    const result = readJson(testFile);

    assert.deepEqual(result, testData);
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  });

  test("reads single event JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
    const testFile = path.join(tmpDir, "event.json");
    const event = {
      specversion: "0.2.0",
      id: "evt_001",
      time: new Date().toISOString(),
      source: "agent://test",
      type: "task.created",
      session_id: "ses_001",
      trace_id: "trc_001",
      payload: {},
    };

    fs.writeFileSync(testFile, JSON.stringify(event));
    const result = readJson(testFile);

    assert.deepEqual(result, event);
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  });

  test("reads array of events JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
    const testFile = path.join(tmpDir, "events.json");
    const events = [
      { specversion: "0.2.0", id: "evt_001", type: "task.created", source: "agent://test", session_id: "ses_001", trace_id: "trc_001", payload: {} },
      { specversion: "0.2.0", id: "evt_002", type: "task.completed", source: "agent://test", session_id: "ses_001", trace_id: "trc_001", payload: {} },
    ];

    fs.writeFileSync(testFile, JSON.stringify(events));
    const result = readJson(testFile);

    assert.equal(Array.isArray(result), true);
    assert.equal(result.length, 2);
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  });

  test("throws error on invalid JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
    const testFile = path.join(tmpDir, "invalid.json");

    fs.writeFileSync(testFile, "{ invalid json }");

    assert.throws(() => {
      readJson(testFile);
    }, SyntaxError);

    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  });

  test("throws error on non-existent file", () => {
    assert.throws(() => {
      readJson("/non/existent/file.json");
    }, Error);
  });
});

// ---------------------------------------------------------------------------
// Tests for event validation logic (integration)
// ---------------------------------------------------------------------------

describe("Event validation in cli-validate context", () => {
  test("validates valid single event", () => {
    const event = {
      specversion: "0.2.0",
      id: "evt_test_001",
      time: new Date().toISOString(),
      source: "agent://test",
      type: "task.created",
      session_id: "ses_test_001",
      trace_id: "trc_test_001",
      payload: { key: "value" },
    };

    const result = validateEvent(event);
    assert.equal(result.valid, true);
  });

  test("rejects event with missing required fields", () => {
    const event = {
      specversion: "0.2.0",
      id: "evt_test_001",
      // missing time, source, type, session_id, trace_id, payload
    };

    const result = validateEvent(event);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  test("rejects event with invalid specversion", () => {
    const event = {
      specversion: "1.0.0", // Should be 0.2.0
      id: "evt_test_001",
      time: new Date().toISOString(),
      source: "agent://test",
      type: "task.created",
      session_id: "ses_test_001",
      trace_id: "trc_test_001",
      payload: {},
    };

    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("rejects event with unknown type", () => {
    const event = {
      specversion: "0.2.0",
      id: "evt_test_001",
      time: new Date().toISOString(),
      source: "agent://test",
      type: "unknown.type", // Not in CORE_EVENT_TYPES
      session_id: "ses_test_001",
      trace_id: "trc_test_001",
      payload: {},
    };

    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("validates array of events", () => {
    const events = [
      {
        specversion: "0.2.0",
        id: "evt_001",
        time: new Date().toISOString(),
        source: "agent://test",
        type: "task.created",
        session_id: "ses_001",
        trace_id: "trc_001",
        payload: {},
      },
      {
        specversion: "0.2.0",
        id: "evt_002",
        time: new Date().toISOString(),
        source: "agent://test",
        type: "task.completed",
        session_id: "ses_001",
        trace_id: "trc_001",
        payload: {},
      },
    ];

    let allValid = true;
    for (const event of events) {
      const result = validateEvent(event);
      if (!result.valid) {
        allValid = false;
        break;
      }
    }

    assert.equal(allValid, true);
  });

  test("tracks validation failures", () => {
    const validEvent = {
      specversion: "0.2.0",
      id: "evt_001",
      time: new Date().toISOString(),
      source: "agent://test",
      type: "task.created",
      session_id: "ses_001",
      trace_id: "trc_001",
      payload: {},
    };

    const invalidEvent = {
      specversion: "0.2.0",
      id: "evt_002",
      // missing required fields
    };

    let failures = 0;
    for (const event of [validEvent, invalidEvent]) {
      const result = validateEvent(event);
      if (!result.valid) {
        failures++;
      }
    }

    assert.equal(failures, 1);
  });
});

// ---------------------------------------------------------------------------
// Tests for file handling scenarios
// ---------------------------------------------------------------------------

describe("File handling in cli-validate", () => {
  test("processes single event from JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
    const testFile = path.join(tmpDir, "event.json");
    const event = {
      specversion: "0.2.0",
      id: "evt_test_001",
      time: new Date().toISOString(),
      source: "agent://test",
      type: "task.created",
      session_id: "ses_test_001",
      trace_id: "trc_test_001",
      payload: {},
    };

    fs.writeFileSync(testFile, JSON.stringify(event));
    const parsed = readJson(testFile);
    const events = Array.isArray(parsed) ? parsed : [parsed];

    assert.equal(events.length, 1);
    const result = validateEvent(events[0]);
    assert.equal(result.valid, true);

    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  });

  test("processes array of events from JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
    const testFile = path.join(tmpDir, "events.json");
    const events = [
      {
        specversion: "0.2.0",
        id: "evt_001",
        time: new Date().toISOString(),
        source: "agent://test",
        type: "task.created",
        session_id: "ses_001",
        trace_id: "trc_001",
        payload: {},
      },
      {
        specversion: "0.2.0",
        id: "evt_002",
        time: new Date().toISOString(),
        source: "agent://test",
        type: "tool.called",
        session_id: "ses_001",
        trace_id: "trc_001",
        payload: {},
      },
    ];

    fs.writeFileSync(testFile, JSON.stringify(events));
    const parsed = readJson(testFile);
    const parsedEvents = Array.isArray(parsed) ? parsed : [parsed];

    assert.equal(parsedEvents.length, 2);
    let validCount = 0;
    for (const event of parsedEvents) {
      if (validateEvent(event).valid) {
        validCount++;
      }
    }
    assert.equal(validCount, 2);

    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  });
});
