{{/*
Expand the chart name.
*/}}
{{- define "aep-operator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a fully qualified app name, capped at 63 chars.
*/}}
{{- define "aep-operator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label: <name>-<version> with '+' replaced by '_'.
*/}}
{{- define "aep-operator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Namespace — respects namespaceOverride, falls back to Release.Namespace.
*/}}
{{- define "aep-operator.namespace" -}}
{{- default .Release.Namespace .Values.namespaceOverride }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "aep-operator.serviceAccountName" -}}
{{- default (include "aep-operator.fullname" .) .Values.serviceAccount.name }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "aep-operator.labels" -}}
helm.sh/chart: {{ include "aep-operator.chart" . }}
{{ include "aep-operator.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels — used in Deployment.spec.selector and Service.spec.selector.
Must be stable across upgrades; never include chart version here.
*/}}
{{- define "aep-operator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aep-operator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Operator container image — tag defaults to .Chart.AppVersion.
*/}}
{{- define "aep-operator.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/*
Sidecar image passed as --sidecar-image argument.
*/}}
{{- define "aep-operator.sidecarImage" -}}
{{- printf "%s:%s" .Values.sidecar.image.repository .Values.sidecar.image.tag }}
{{- end }}

{{/*
Name of the webhook TLS Secret (must match cert-manager Certificate secretName).
*/}}
{{- define "aep-operator.webhookCertSecret" -}}
{{- printf "%s-webhook-server-cert" (include "aep-operator.fullname" .) }}
{{- end }}

{{/*
Name of the webhook Service.
*/}}
{{- define "aep-operator.webhookServiceName" -}}
{{- printf "%s-webhook-service" (include "aep-operator.fullname" .) }}
{{- end }}
