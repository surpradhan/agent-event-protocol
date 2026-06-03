package aep

import (
	"context"
	"sync"
	"time"
)

// AsyncClient is an asynchronous AEP HTTP client that uses goroutines for concurrent event emission.
// Unlike the sync Client which processes events sequentially, AsyncClient launches goroutines
// to emit multiple events concurrently, making it more efficient for high-throughput scenarios.
type AsyncClient struct {
	baseClient *Client
}

// NewAsyncClient creates a new async AEP client.
func NewAsyncClient() *AsyncClient {
	return &AsyncClient{
		baseClient: NewClient(),
	}
}

// NewAsyncClientWithURL creates a new async AEP client with a custom server URL.
func NewAsyncClientWithURL(serverURL string) *AsyncClient {
	return &AsyncClient{
		baseClient: NewClientWithURL(serverURL),
	}
}

// SetAPIKey sets the API key for authentication.
func (ac *AsyncClient) SetAPIKey(apiKey string) {
	ac.baseClient.SetAPIKey(apiKey)
}

// SetTimeout sets the HTTP client timeout.
func (ac *AsyncClient) SetTimeout(timeout time.Duration) {
	ac.baseClient.SetTimeout(timeout)
}

// Close closes the underlying client connection pool.
func (ac *AsyncClient) Close() error {
	return ac.baseClient.Close()
}

// String returns a string representation of the async client.
func (ac *AsyncClient) String() string {
	return "AsyncClient{" + ac.baseClient.String() + "}"
}

// EmitAsync sends a single event asynchronously.
// Returns a channel that will receive the result or an error.
func (ac *AsyncClient) EmitAsync(ctx context.Context, event *Event) <-chan *EmitResult {
	resultChan := make(chan *EmitResult, 1)

	go func() {
		defer close(resultChan)
		resp, err := ac.baseClient.Emit(ctx, event)
		resultChan <- &EmitResult{Response: resp, Error: err}
	}()

	return resultChan
}

// EmitBatch sends multiple events concurrently using goroutines and waits for all to complete.
// Returns all responses or the first error encountered.
// Respects context cancellation and will return early if context is cancelled.
func (ac *AsyncClient) EmitBatch(ctx context.Context, events []*Event) ([]*EmitResponse, error) {
	if len(events) == 0 {
		return []*EmitResponse{}, nil
	}

	results := make([]*EmitResponse, len(events))
	errors := make([]error, len(events))
	var wg sync.WaitGroup

	// Launch goroutines for each event
	for i, event := range events {
		wg.Add(1)
		go func(idx int, evt *Event) {
			defer wg.Done()
			// Check if context is already cancelled
			select {
			case <-ctx.Done():
				errors[idx] = ctx.Err()
				return
			default:
			}
			resp, err := ac.baseClient.Emit(ctx, evt)
			results[idx] = resp
			errors[idx] = err
		}(i, event)
	}

	// Wait for all goroutines to complete
	wg.Wait()

	// Check for errors
	for _, err := range errors {
		if err != nil {
			return nil, err
		}
	}

	return results, nil
}

// EmitResult holds the result of an async emit operation.
type EmitResult struct {
	Response *EmitResponse
	Error    error
}

// EmitBatchConcurrent sends multiple events concurrently and returns results in a channel as they arrive.
// Results are streamed to the channel without waiting for all events to complete.
// This differs from EmitBatch, which waits for all events to complete before returning.
// Allows processing results immediately as they arrive rather than waiting for all completions.
func (ac *AsyncClient) EmitBatchConcurrent(ctx context.Context, events []*Event) <-chan *EmitResult {
	resultChan := make(chan *EmitResult, len(events))

	go func() {
		defer close(resultChan)
		var wg sync.WaitGroup

		for _, event := range events {
			wg.Add(1)
			go func(evt *Event) {
				defer wg.Done()
				resp, err := ac.baseClient.Emit(ctx, evt)
				resultChan <- &EmitResult{Response: resp, Error: err}
			}(event)
		}

		wg.Wait()
	}()

	return resultChan
}
