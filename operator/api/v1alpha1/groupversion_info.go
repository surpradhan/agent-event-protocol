// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

// Package v1alpha1 contains API Schema definitions for the aep.dev v1alpha1 API group.
// +groupName=aep.dev
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is the group version for the AEP operator API.
	GroupVersion = schema.GroupVersion{Group: "aep.dev", Version: "v1alpha1"}

	// SchemeBuilder is used to register Go types with a Kubernetes scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds the types in this group-version to the given scheme.
	// Called from main.go's init() to register AgentInstrumentation types.
	AddToScheme = SchemeBuilder.AddToScheme
)
