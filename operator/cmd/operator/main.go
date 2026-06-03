// Package main is the entrypoint for the AEP Kubernetes Operator.
// It registers the AgentInstrumentation controller and the sidecar-injection
// mutating webhook, then starts the controller-runtime manager.
package main

import (
	"flag"
	"fmt"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	aepv1alpha1 "github.com/surpradhan/aep-operator/api/v1alpha1"
	"github.com/surpradhan/aep-operator/internal/controller"
	"github.com/surpradhan/aep-operator/internal/webhook"
)

// Build-time version information injected via ldflags:
//
//	-X main.version=$(git describe --tags --always --dirty)
//	-X main.gitCommit=$(git rev-parse --short HEAD)
//	-X main.buildDate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
var (
	version   = "dev"
	gitCommit = "none"
	buildDate = "unknown"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(aepv1alpha1.AddToScheme(scheme))
}

func main() {
	var (
		metricsAddr          string
		probeAddr            string
		enableLeaderElection bool
		aepServerURL         string
		sidecarImage         string
		showVersion          bool
	)

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080",
		"The address the metrics endpoint binds to.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081",
		"The address the health probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false,
		"Enable leader election for high-availability deployments. "+
			"Recommended for production (set to true).")
	flag.StringVar(&aepServerURL, "aep-server-url", "http://aep-ingest.aep-system.svc.cluster.local:8787",
		"URL of the AEP ingest server.")
	flag.StringVar(&sidecarImage, "sidecar-image", "ghcr.io/surpradhan/aep-sidecar:latest",
		"Container image for the AEP sidecar injected into agent pods.")
	flag.BoolVar(&showVersion, "version", false,
		"Print version information and exit.")

	// zap.Options defaults Development to false; flags allow override at runtime.
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	if showVersion {
		fmt.Printf("aep-operator version=%s commit=%s buildDate=%s\n",
			version, gitCommit, buildDate)
		os.Exit(0)
	}

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme: scheme,
		Metrics: metricsserver.Options{
			BindAddress: metricsAddr,
		},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "aep-operator.aep.dev",
	})
	if err != nil {
		setupLog.Error(err, "unable to create manager")
		os.Exit(1)
	}

	// Register the AgentInstrumentation reconciler.
	if err = (&controller.AgentInstrumentationReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to set up AgentInstrumentation controller")
		os.Exit(1)
	}

	// Register the sidecar-injection mutating webhook.
	if err = (&webhook.SidecarInjector{
		Client:       mgr.GetClient(),
		AEPServerURL: aepServerURL,
		SidecarImage: sidecarImage,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to set up sidecar injector webhook")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("starting AEP operator",
		"version", version,
		"commit", gitCommit,
		"aep-server-url", aepServerURL,
		"sidecar-image", sidecarImage,
	)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
