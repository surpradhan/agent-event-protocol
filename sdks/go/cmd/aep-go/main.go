package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/surpradhan/aep-go/aep"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]

	switch cmd {
	case "emit":
		handleEmit(os.Args[2:])
	case "session":
		handleSession(os.Args[2:])
	case "validate":
		handleValidate(os.Args[2:])
	case "health":
		handleHealth(os.Args[2:])
	case "help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func handleEmit(args []string) {
	fs := flag.NewFlagSet("emit", flag.ExitOnError)
	source := fs.String("source", "", "Event source (required)")
	eventType := fs.String("type", "", "Event type (required)")
	sessionID := fs.String("session", "", "Session ID (required)")
	traceID := fs.String("trace", "", "Trace ID (required)")
	serverURL := fs.String("server", aep.DefaultServerURL, "AEP server URL")
	apiKey := fs.String("key", "", "API key (optional)")

	fs.Parse(args)

	if *source == "" || *eventType == "" || *sessionID == "" || *traceID == "" {
		fmt.Fprintln(os.Stderr, "Error: --source, --type, --session, and --trace are required")
		fs.PrintDefaults()
		os.Exit(1)
	}

	event, err := aep.CreateEvent(
		*source,
		aep.EventType(*eventType),
		*sessionID,
		*traceID,
		map[string]interface{}{},
		nil,
	)
	if err != nil {
		log.Fatalf("Failed to create event: %v", err)
	}

	client := aep.NewClientWithURL(*serverURL)
	if *apiKey != "" {
		client.SetAPIKey(*apiKey)
	}

	ctx := context.Background()
	resp, err := client.Emit(ctx, event)
	if err != nil {
		log.Fatalf("Failed to emit event: %v", err)
	}

	fmt.Printf("Event emitted successfully!\n")
	fmt.Printf("ID: %s\n", resp.ID)
	fmt.Printf("Accepted: %v\n", resp.Accepted)
	fmt.Printf("Duplicate: %v\n", resp.Duplicate)
}

func handleSession(args []string) {
	fs := flag.NewFlagSet("session", flag.ExitOnError)
	sessionID := fs.String("id", "", "Session ID (required)")
	serverURL := fs.String("server", aep.DefaultServerURL, "AEP server URL")
	apiKey := fs.String("key", "", "API key (optional)")

	fs.Parse(args)

	if *sessionID == "" {
		fmt.Fprintln(os.Stderr, "Error: --id is required")
		fs.PrintDefaults()
		os.Exit(1)
	}

	client := aep.NewClientWithURL(*serverURL)
	if *apiKey != "" {
		client.SetAPIKey(*apiKey)
	}

	ctx := context.Background()
	session, err := client.GetSession(ctx, *sessionID)
	if err != nil {
		log.Fatalf("Failed to get session: %v", err)
	}

	fmt.Printf("Session: %s\n", session.SessionID)
	fmt.Printf("Trace ID: %s\n", session.TraceID)
	fmt.Printf("Source: %s\n", session.Source)
	fmt.Printf("Event Count: %d\n", session.EventCount)
	fmt.Printf("Started At: %s\n", session.StartedAt)
	fmt.Printf("Updated At: %s\n", session.UpdatedAt)
}

func handleValidate(args []string) {
	fs := flag.NewFlagSet("validate", flag.ExitOnError)
	filePath := fs.String("file", "", "Event JSON file (required)")

	fs.Parse(args)

	if *filePath == "" {
		fmt.Fprintln(os.Stderr, "Error: --file is required")
		fs.PrintDefaults()
		os.Exit(1)
	}

	// This is a placeholder for now
	fmt.Fprintf(os.Stderr, "validate command is not yet implemented\n")
	os.Exit(1)
}

func handleHealth(args []string) {
	fs := flag.NewFlagSet("health", flag.ExitOnError)
	serverURL := fs.String("server", aep.DefaultServerURL, "AEP server URL")

	fs.Parse(args)

	client := aep.NewClientWithURL(*serverURL)

	ctx := context.Background()
	healthy, err := client.GetHealth(ctx)
	if err != nil {
		log.Fatalf("Health check failed: %v", err)
	}

	if healthy {
		fmt.Println("Server is healthy")
		os.Exit(0)
	} else {
		fmt.Println("Server is not healthy")
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `AEP Go SDK CLI

Usage:
  aep-go <command> [options]

Commands:
  emit      Emit an event
  session   Get session information
  validate  Validate event file
  health    Check server health
  help      Show this help message

Options vary by command. Use "aep-go <command> -h" for details.
`)
}
