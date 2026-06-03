package aep

import (
	"testing"
)

func TestSignEvent(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "test"},
		nil,
	)

	secret := "test_secret"
	signedEvent, err := SignEvent(event, secret)

	if err != nil {
		t.Fatalf("SignEvent failed: %v", err)
	}

	if signedEvent.Signature == nil {
		t.Error("Expected signature to be set")
	}

	if signedEvent.Signature.Alg != "hmac-sha256" {
		t.Errorf("Expected alg 'hmac-sha256', got %s", signedEvent.Signature.Alg)
	}

	if signedEvent.Signature.Val == "" {
		t.Error("Expected signature value to be set")
	}
}

func TestVerifySignatureValid(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "test"},
		nil,
	)

	secret := "test_secret"
	signedEvent, _ := SignEvent(event, secret)

	valid, err := VerifySignature(signedEvent, secret)

	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}

	if !valid {
		t.Error("Expected signature to be valid")
	}
}

func TestVerifySignatureInvalid(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "test"},
		nil,
	)

	secret := "test_secret"
	wrongSecret := "wrong_secret"

	signedEvent, _ := SignEvent(event, secret)
	valid, err := VerifySignature(signedEvent, wrongSecret)

	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}

	if valid {
		t.Error("Expected signature to be invalid with wrong secret")
	}
}

func TestVerifySignatureTamperedPayload(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "original"},
		nil,
	)

	secret := "test_secret"
	signedEvent, _ := SignEvent(event, secret)

	// Tamper with payload
	signedEvent.Payload = map[string]interface{}{"task": "tampered"}

	valid, err := VerifySignature(signedEvent, secret)

	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}

	if valid {
		t.Error("Expected signature to be invalid after payload tampering")
	}
}

func TestSignEventNoSecret(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		nil,
	)

	_, err := SignEvent(event, "")

	if err == nil {
		t.Error("Expected error for empty secret")
	}

	if _, ok := err.(*ErrValidation); !ok {
		t.Errorf("Expected ErrValidation, got %T", err)
	}
}

func TestVerifySignatureNoSignature(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		nil,
	)

	_, err := VerifySignature(event, "secret")

	if err == nil {
		t.Error("Expected error for event without signature")
	}

	if _, ok := err.(*ErrValidation); !ok {
		t.Errorf("Expected ErrValidation, got %T", err)
	}
}

func TestSignatureConsistency(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "test"},
		nil,
	)

	secret := "test_secret"

	// Sign the same event multiple times
	signed1, _ := SignEvent(event, secret)
	signed2, _ := SignEvent(event, secret)

	// Signatures should be the same for the same event and secret
	if signed1.Signature.Val != signed2.Signature.Val {
		t.Error("Signatures should be consistent for the same event")
	}
}
