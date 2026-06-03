package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/surpradhan/aep-go/aep"
)

// This example demonstrates a multi-agent research workflow where an orchestrator
// spawns three parallel sub-agents to search, analyze, and synthesize research.

func main() {
	client := aep.NewClient()
	// Uncomment to test against a specific server:
	// client = aep.NewClientWithURL("http://localhost:8787")

	ctx := context.Background()

	// Create the root orchestrator session
	workflowID := uuid.New().String()
	orchestratorSessionID := uuid.New().String()

	log.Printf("Starting research workflow: %s", workflowID)
	log.Printf("Orchestrator session: %s", orchestratorSessionID)

	// Orchestrator event: task created
	orchestratorEvent, _ := aep.CreateEvent(
		"agent://orchestrator",
		aep.EventTypeTaskCreated,
		orchestratorSessionID,
		workflowID,
		map[string]interface{}{
			"task": "Research quantum computing trends",
			"query": "quantum computing applications 2024",
		},
		nil,
	)

	if _, err := client.Emit(ctx, orchestratorEvent); err != nil {
		log.Fatalf("Failed to emit orchestrator event: %v", err)
	}
	log.Printf("Emitted orchestrator event: %s", orchestratorEvent.ID)

	// Spawn three sub-agent workflows in parallel
	subagentSessionIDs := []string{
		uuid.New().String(),
		uuid.New().String(),
		uuid.New().String(),
	}

	var wg sync.WaitGroup
	agents := []struct {
		name       string
		sessionID  string
		role       string
	}{
		{"search-agent", subagentSessionIDs[0], "search engine queries"},
		{"analysis-agent", subagentSessionIDs[1], "technical analysis"},
		{"synthesis-agent", subagentSessionIDs[2], "report generation"},
	}

	for _, agent := range agents {
		wg.Add(1)
		go func(a struct {
			name       string
			sessionID  string
			role       string
		}) {
			defer wg.Done()
			runSubagent(ctx, client, workflowID, orchestratorSessionID, a.name, a.sessionID, a.role)
		}(agent)
	}

	wg.Wait()

	// Orchestrator event: task completed
	completionEvent, _ := aep.CreateEvent(
		"agent://orchestrator",
		aep.EventTypeTaskCompleted,
		orchestratorSessionID,
		workflowID,
		map[string]interface{}{
			"status": "all sub-agents completed",
			"results": "synthesis ready",
		},
		&aep.CreateEventOptions{
			CausationID: &orchestratorEvent.ID,
		},
	)

	if _, err := client.Emit(ctx, completionEvent); err != nil {
		log.Fatalf("Failed to emit completion event: %v", err)
	}

	log.Printf("Research workflow completed: %s", completionEvent.ID)
	log.Printf("View results: curl http://localhost:8787/workflows/%s", workflowID)
}

func runSubagent(ctx context.Context, client *aep.Client, workflowID, parentSessionID, agentName, sessionID, role string) {
	// Sub-agent event: task created
	subagentRole := aep.AgentRoleSubagent
	startEvent, _ := aep.CreateEvent(
		fmt.Sprintf("agent://%s", agentName),
		aep.EventTypeTaskCreated,
		sessionID,
		workflowID,
		map[string]interface{}{
			"role": role,
			"query": "quantum computing applications 2024",
		},
		&aep.CreateEventOptions{
			ParentSessionID: &parentSessionID,
			AgentRole:       &subagentRole,
		},
	)

	if _, err := client.Emit(ctx, startEvent); err != nil {
		log.Printf("[%s] Failed to emit start event: %v", agentName, err)
		return
	}
	log.Printf("[%s] Started: %s", agentName, startEvent.ID)

	// Simulate work
	time.Sleep(time.Duration(100+len(agentName)%50) * time.Millisecond)

	// Tool call event
	toolEvent, _ := aep.CreateEvent(
		fmt.Sprintf("agent://%s", agentName),
		aep.EventTypeToolCalled,
		sessionID,
		workflowID,
		map[string]interface{}{
			"tool": "search_engine",
			"query": "quantum computing 2024",
		},
		&aep.CreateEventOptions{
			CausationID: &startEvent.ID,
		},
	)

	if _, err := client.Emit(ctx, toolEvent); err != nil {
		log.Printf("[%s] Failed to emit tool event: %v", agentName, err)
		return
	}
	log.Printf("[%s] Tool called: %s", agentName, toolEvent.ID)

	// Tool result event
	resultEvent, _ := aep.CreateEvent(
		fmt.Sprintf("agent://%s", agentName),
		aep.EventTypeToolResult,
		sessionID,
		workflowID,
		map[string]interface{}{
			"tool": "search_engine",
			"results": []string{
				"Quantum supremacy achieved with 1M qubits",
				"New error correction breakthrough",
				"Commercial quantum cloud platforms expanding",
			},
		},
		&aep.CreateEventOptions{
			CausationID: &toolEvent.ID,
		},
	)

	if _, err := client.Emit(ctx, resultEvent); err != nil {
		log.Printf("[%s] Failed to emit result event: %v", agentName, err)
		return
	}
	log.Printf("[%s] Tool result: %s", agentName, resultEvent.ID)

	// Task completed event
	completionEvent, _ := aep.CreateEvent(
		fmt.Sprintf("agent://%s", agentName),
		aep.EventTypeTaskCompleted,
		sessionID,
		workflowID,
		map[string]interface{}{
			"role": role,
			"findings": fmt.Sprintf("%s analysis complete", role),
		},
		&aep.CreateEventOptions{
			CausationID: &resultEvent.ID,
		},
	)

	if _, err := client.Emit(ctx, completionEvent); err != nil {
		log.Printf("[%s] Failed to emit completion event: %v", agentName, err)
		return
	}
	log.Printf("[%s] Completed: %s", agentName, completionEvent.ID)
}
