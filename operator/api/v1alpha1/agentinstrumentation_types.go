// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Condition type and reason constants for AgentInstrumentation.
const (
	// ConditionReady is the sole condition type used by AgentInstrumentation.
	// Use the Reason constants below to convey specific states rather than
	// adding a separate Degraded condition (which can produce ambiguous
	// Ready=True + Degraded=True combinations).
	ConditionReady = "Ready"

	// ReasonActive is set on Ready=True when injection is active and healthy.
	ReasonActive = "Active"

	// ReasonDisabled is set on Ready=False when spec.enabled is false.
	ReasonDisabled = "Disabled"

	// ReasonInjectionFailed is set on Ready=False when one or more pods
	// failed sidecar injection.
	ReasonInjectionFailed = "InjectionFailed"

	// ReasonWebhookError is set on Ready=False when the mutating webhook
	// could not be registered or becomes unreachable.
	ReasonWebhookError = "WebhookError"
)

// AgentInstrumentationSpec defines the desired state of AgentInstrumentation.
//
// Selector overlap: if multiple AgentInstrumentation resources match the same
// namespace or pod, the one whose name sorts first alphabetically takes
// precedence. Operators should ensure selectors are non-overlapping.
type AgentInstrumentationSpec struct {
	// Enabled controls whether sidecar injection is active for this resource.
	// Set to false to pause injection without deleting the resource.
	// Defaults to true.
	// +kubebuilder:default=true
	Enabled bool `json:"enabled"`

	// NamespaceSelector restricts sidecar injection to namespaces matching
	// this label selector. When nil, all namespaces are eligible.
	// +optional
	NamespaceSelector *metav1.LabelSelector `json:"namespaceSelector,omitempty"`

	// PodSelector filters which pods are counted in status.injectedCount within
	// eligible namespaces. Note: this selector does NOT gate webhook injection —
	// any pod annotated aep.dev/inject=true in a covered namespace will receive
	// the sidecar regardless of its labels. Use this field to scope the injected
	// pod count reported in status, not to restrict which pods get instrumented.
	// When nil, all pods carrying aep.dev/injected=true are counted.
	// +optional
	PodSelector *metav1.LabelSelector `json:"podSelector,omitempty"`

	// AEPServerURL is the URL of the AEP ingest server the injected sidecar
	// will emit events to. Overrides the operator-level --aep-server-url flag.
	// Example: "http://aep-ingest.aep-system.svc.cluster.local:8787"
	// +optional
	// +kubebuilder:validation:Pattern=`^https?://.+`
	AEPServerURL string `json:"aepServerURL,omitempty"`

	// APIKeySecretRef references the Secret containing the AEP API key.
	// The sidecar presents the value as an Authorization: Bearer <token> header
	// on every event POST. When nil, the sidecar connects without authentication
	// (only suitable for servers with no DASHBOARD_TOKEN / ADMIN_TOKEN set).
	// +optional
	APIKeySecretRef *corev1.SecretKeySelector `json:"apiKeySecretRef,omitempty"`

	// SidecarImage is the container image for the injected AEP sidecar.
	// Overrides the operator-level --sidecar-image flag.
	// Example: "ghcr.io/surpradhan/aep-sidecar:v1.0.0"
	// +optional
	SidecarImage string `json:"sidecarImage,omitempty"`

	// Resources specifies compute resource requests and limits for the
	// injected sidecar container. When unset, the sidecar runs with no
	// resource constraints (not recommended for production).
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// Env is a list of additional environment variables to inject into the
	// sidecar container. These supplement (and may override) the defaults
	// set by the operator (AEP_SERVER_URL, AEP_POD_NAME, etc.).
	// +optional
	// +listType=map
	// +listMapKey=name
	Env []corev1.EnvVar `json:"env,omitempty"`
}

// AgentInstrumentationStatus defines the observed state of AgentInstrumentation.
type AgentInstrumentationStatus struct {
	// ObservedGeneration is the .metadata.generation the controller last
	// successfully reconciled. Used to detect stale status.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// InjectedCount is the number of pods currently carrying the AEP sidecar
	// as a result of this instrumentation resource.
	// +optional
	InjectedCount int32 `json:"injectedCount,omitempty"`

	// Conditions represent the latest available observations of this resource.
	//
	// Known condition type: Ready.
	//   Ready=True  (reason: Active)          — injection is active and healthy.
	//   Ready=False (reason: Disabled)        — spec.enabled is false.
	//   Ready=False (reason: InjectionFailed) — one or more pods failed injection.
	//   Ready=False (reason: WebhookError)    — webhook registration failed.
	//
	// +patchMergeKey=type
	// +patchStrategy=merge
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// AgentInstrumentation is the Schema for the agentinstrumentations API.
// It configures which pods receive an injected AEP observability sidecar
// and how that sidecar is configured.
//
// Example — instrument all pods in namespaces labelled aep.dev/instrumented=true:
//
//	apiVersion: aep.dev/v1alpha1
//	kind: AgentInstrumentation
//	metadata:
//	  name: ai-workloads
//	spec:
//	  enabled: true
//	  namespaceSelector:
//	    matchLabels:
//	      aep.dev/instrumented: "true"
//	  apiKeySecretRef:
//	    name: aep-api-key
//	    key: token
//
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=ainstr,categories=aep
// +kubebuilder:printcolumn:name="Enabled",type=boolean,JSONPath=`.spec.enabled`
// +kubebuilder:printcolumn:name="Injected",type=integer,JSONPath=`.status.injectedCount`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type AgentInstrumentation struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	// Spec is required. Create with at minimum spec.enabled=true (the default).
	Spec   AgentInstrumentationSpec   `json:"spec"`
	Status AgentInstrumentationStatus `json:"status,omitempty"`
}

// AgentInstrumentationList contains a list of AgentInstrumentation resources.
//
// +kubebuilder:object:root=true
type AgentInstrumentationList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentInstrumentation `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AgentInstrumentation{}, &AgentInstrumentationList{})
}
