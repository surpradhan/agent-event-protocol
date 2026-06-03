// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Condition type constants for AgentInstrumentation.
const (
	// ConditionReady indicates the instrumentation is active and healthy.
	ConditionReady = "Ready"

	// ConditionDegraded indicates injection failures on one or more pods.
	ConditionDegraded = "Degraded"
)

// AgentInstrumentationSpec defines the desired state of AgentInstrumentation.
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

	// PodSelector restricts sidecar injection to pods matching this label
	// selector within eligible namespaces. When nil, all pods annotated
	// with aep.dev/inject=true are eligible.
	// +optional
	PodSelector *metav1.LabelSelector `json:"podSelector,omitempty"`

	// AEPServerURL is the URL of the AEP ingest server the injected sidecar
	// will emit events to. Overrides the operator-level --aep-server-url flag.
	// Example: "http://aep-ingest.aep-system.svc.cluster.local:8787"
	// +optional
	// +kubebuilder:validation:Pattern=`^https?://.+`
	AEPServerURL string `json:"aepServerURL,omitempty"`

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
	// Known condition types:
	//   - Ready:    instrumentation is active; injection is succeeding.
	//   - Degraded: one or more pods failed sidecar injection.
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
// Example — instrument all pods in the "ai-workloads" namespace:
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

	Spec   AgentInstrumentationSpec   `json:"spec,omitempty"`
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
