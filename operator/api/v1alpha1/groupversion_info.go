// Package v1alpha1 contains API types for the AEP operator.
// Full types are defined in Step 2 (agentinstrumentation_types.go).
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// SchemeGroupVersion is the group version for the AEP operator API.
var SchemeGroupVersion = schema.GroupVersion{Group: "aep.dev", Version: "v1alpha1"}

// AddToScheme adds AEP types to the given scheme.
// Stub — types will be registered in Step 2 once CRD types are defined.
func AddToScheme(_ *runtime.Scheme) error {
	return nil
}
