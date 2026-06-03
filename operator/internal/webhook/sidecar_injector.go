// Package webhook implements the AEP sidecar-injection mutating webhook.
// Full injection logic is added in Step 4.
package webhook

import (
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// SidecarInjector handles mutating webhook admission requests.
// It injects the AEP sidecar container into pods annotated with
// aep.dev/inject=true — full implementation in Step 4.
type SidecarInjector struct {
	Client       client.Client
	AEPServerURL string
	SidecarImage string
}

// SetupWithManager registers the webhook with the manager.
// Full webhook server registration is added in Step 4.
func (s *SidecarInjector) SetupWithManager(_ ctrl.Manager) error {
	return nil
}
