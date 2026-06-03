package aep

import "fmt"

// AEPError is the base error type for all AEP-related errors.
type AEPError struct {
	Message string
	Code    string
	Err     error
}

func (e *AEPError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s (%s)", e.Code, e.Message, e.Err.Error())
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *AEPError) Unwrap() error {
	return e.Err
}

// ErrValidation is returned when event validation fails.
type ErrValidation struct {
	*AEPError
}

// ErrAuth is returned when authentication fails (401).
type ErrAuth struct {
	*AEPError
}

// ErrRateLimit is returned when rate limit is exceeded (429).
type ErrRateLimit struct {
	*AEPError
	RetryAfter int // seconds
}

// ErrNotFound is returned when a resource is not found (404).
type ErrNotFound struct {
	*AEPError
}

// ErrConnection is returned when connection fails.
type ErrConnection struct {
	*AEPError
}

// ErrServer is returned for server errors (5xx).
type ErrServer struct {
	*AEPError
	StatusCode int
}

// NewValidationError creates a new validation error.
func NewValidationError(message string, err error) *ErrValidation {
	return &ErrValidation{
		AEPError: &AEPError{
			Message: message,
			Code:    "VALIDATION_ERROR",
			Err:     err,
		},
	}
}

// NewAuthError creates a new auth error.
func NewAuthError(message string, err error) *ErrAuth {
	return &ErrAuth{
		AEPError: &AEPError{
			Message: message,
			Code:    "AUTH_ERROR",
			Err:     err,
		},
	}
}

// NewRateLimitError creates a new rate limit error.
func NewRateLimitError(message string, retryAfter int, err error) *ErrRateLimit {
	return &ErrRateLimit{
		AEPError: &AEPError{
			Message: message,
			Code:    "RATE_LIMIT_ERROR",
			Err:     err,
		},
		RetryAfter: retryAfter,
	}
}

// NewNotFoundError creates a new not found error.
func NewNotFoundError(message string, err error) *ErrNotFound {
	return &ErrNotFound{
		AEPError: &AEPError{
			Message: message,
			Code:    "NOT_FOUND_ERROR",
			Err:     err,
		},
	}
}

// NewConnectionError creates a new connection error.
func NewConnectionError(message string, err error) *ErrConnection {
	return &ErrConnection{
		AEPError: &AEPError{
			Message: message,
			Code:    "CONNECTION_ERROR",
			Err:     err,
		},
	}
}

// NewServerError creates a new server error.
func NewServerError(message string, statusCode int, err error) *ErrServer {
	return &ErrServer{
		AEPError: &AEPError{
			Message: message,
			Code:    "SERVER_ERROR",
			Err:     err,
		},
		StatusCode: statusCode,
	}
}
