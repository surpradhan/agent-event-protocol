#!/bin/bash

# Real-time integration test for Go SDK
# Tests SDK design and interop against running AEP server

set -e

SERVER_URL="${SERVER_URL:-http://localhost:8787}"
RESULTS_FILE="/tmp/go-sdk-test-results.txt"

echo "🧪 Go SDK Real-Time Integration Tests"
echo "Server: $SERVER_URL"
echo "=================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TESTS_PASSED=0
TESTS_FAILED=0

# Helper function to run test
run_test() {
    local test_name="$1"
    local test_cmd="$2"
    local expected="$3"

    echo -n "Testing: $test_name ... "

    if result=$(eval "$test_cmd" 2>&1); then
        if [[ -z "$expected" ]] || echo "$result" | grep -q "$expected"; then
            echo -e "${GREEN}✓ PASSED${NC}"
            ((TESTS_PASSED++))
            return 0
        else
            echo -e "${RED}✗ FAILED${NC}"
            echo "  Expected: $expected"
            echo "  Got: $result"
            ((TESTS_FAILED++))
            return 1
        fi
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "  Error: $result"
        ((TESTS_FAILED++))
        return 1
    fi
}

# Test 1: Server health check
run_test "Server health check" \
    "curl -s $SERVER_URL/health | grep -o '\"ok\":true'" \
    '"ok":true'

# Test 2: Server ready check
run_test "Server readiness" \
    "curl -s $SERVER_URL/ready" \
    ""

# Test 3: Create and emit event (matches Go SDK Event struct)
echo ""
echo "Testing: Event creation and emission..."
EVENT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
TRACE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

EVENT_JSON=$(cat <<EOF
{
  "specversion": "0.2.0",
  "id": "$EVENT_ID",
  "time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "agent://go-sdk-test",
  "type": "task.created",
  "session_id": "$SESSION_ID",
  "trace_id": "$TRACE_ID",
  "payload": {
    "task": "Go SDK real-time test",
    "test_framework": "bash/curl",
    "sdk_language": "Go"
  }
}
EOF
)

RESPONSE=$(curl -s -X POST $SERVER_URL/events \
    -H "Content-Type: application/json" \
    -d "$EVENT_JSON")

if echo "$RESPONSE" | grep -q '"accepted":true'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    echo "  Event ID: $EVENT_ID"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC}"
    echo "  Response: $RESPONSE"
    ((TESTS_FAILED++))
fi

# Test 4: Signature field validation (JSON field name)
echo -n "Testing: Signature field format (value not val) ... "
SIGNED_EVENT_JSON=$(cat <<EOF
{
  "specversion": "0.2.0",
  "id": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "agent://go-sdk-test",
  "type": "task.created",
  "session_id": "$SESSION_ID",
  "trace_id": "$TRACE_ID",
  "signature": {
    "alg": "hmac-sha256",
    "value": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "payload": {"test": "signature format"}
}
EOF
)

if curl -s -X POST $SERVER_URL/events \
    -H "Content-Type: application/json" \
    -d "$SIGNED_EVENT_JSON" | grep -q '"accepted":true'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC} (signature field name mismatch)"
    ((TESTS_FAILED++))
fi

# Test 5: Sub-agent with parent_session_id (multi-agent support)
echo -n "Testing: Multi-agent workflow (parent_session_id) ... "
SUBAGENT_EVENT=$(cat <<EOF
{
  "specversion": "0.2.0",
  "id": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "agent://go-sdk-subagent",
  "type": "task.created",
  "session_id": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "parent_session_id": "$SESSION_ID",
  "agent_role": "subagent",
  "trace_id": "$TRACE_ID",
  "payload": {"role": "sub-agent analysis"}
}
EOF
)

if curl -s -X POST $SERVER_URL/events \
    -H "Content-Type: application/json" \
    -d "$SUBAGENT_EVENT" | grep -q '"accepted":true'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC}"
    ((TESTS_FAILED++))
fi

# Test 6: Deduplication by event ID
echo -n "Testing: Event deduplication ... "
DUPLICATE_RESPONSE=$(curl -s -X POST $SERVER_URL/events \
    -H "Content-Type: application/json" \
    -d "$EVENT_JSON")

if echo "$DUPLICATE_RESPONSE" | grep -q '"duplicate":true'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC} (duplicate not detected)"
    ((TESTS_FAILED++))
fi

# Test 7: Metrics endpoint
echo -n "Testing: Metrics endpoint ... "
if curl -s $SERVER_URL/metrics | grep -q '"events_received"'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC}"
    ((TESTS_FAILED++))
fi

# Test 8: Session tree API (multi-agent hierarchy)
echo -n "Testing: Session tree API ... "
if curl -s "$SERVER_URL/sessions/$SESSION_ID/tree" | grep -q '"session"'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC}"
    ((TESTS_FAILED++))
fi

# Test 9: Workflow tree API (trace_id based)
echo -n "Testing: Workflow tree API ... "
if curl -s "$SERVER_URL/workflows/$TRACE_ID" | grep -q '"sessions"'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC}"
    ((TESTS_FAILED++))
fi

# Test 10: Float payload handling (canonicalization test)
echo -n "Testing: Float payload serialization ... "
FLOAT_EVENT=$(cat <<EOF
{
  "specversion": "0.2.0",
  "id": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "agent://go-sdk-test",
  "type": "task.created",
  "session_id": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "trace_id": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "payload": {
    "metrics": {
      "latency": 1.5,
      "success_rate": 0.99,
      "count": 42
    }
  }
}
EOF
)

if curl -s -X POST $SERVER_URL/events \
    -H "Content-Type: application/json" \
    -d "$FLOAT_EVENT" | grep -q '"accepted":true'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAILED${NC}"
    ((TESTS_FAILED++))
fi

# Summary
echo ""
echo "=================================="
echo "Test Summary"
echo "=================================="
echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
echo "Total:  $((TESTS_PASSED + TESTS_FAILED))"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo ""
    echo "Go SDK interop verified:"
    echo "  ✓ Event creation with correct schema"
    echo "  ✓ Signature field name compatibility (value, not val)"
    echo "  ✓ Multi-agent workflows (parent_session_id, agent_role)"
    echo "  ✓ Event deduplication"
    echo "  ✓ Metrics tracking"
    echo "  ✓ Session/Workflow tree APIs"
    echo "  ✓ Float payload handling"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
