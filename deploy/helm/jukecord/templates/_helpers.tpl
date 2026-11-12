{{/*
Names and labels. Every object is called by the release's full name ("jukecord" for a release called jukecord).
*/}}

{{- define "jukecord.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "jukecord.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The labels the pod is selected by. */}}
{{- define "jukecord.selectorLabels" -}}
app.kubernetes.io/name: {{ include "jukecord.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Every label of the chart's objects. The component tells jukecord's own objects from helm test's pod; it is not one of
the selector labels, which a Deployment cannot change after it is made.
*/}}
{{- define "jukecord.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "jukecord.selectorLabels" . }}
app.kubernetes.io/component: server
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* The pod's labels: podLabels from the values, under the chart's own, which win (the Service and the NetworkPolicy
find the pod by them). */}}
{{- define "jukecord.podLabels" -}}
{{- toYaml (merge (include "jukecord.labels" . | fromYaml) .Values.podLabels) -}}
{{- end -}}

{{/* "repository:tag", the tag defaulting to the chart's appVersion. */}}
{{- define "jukecord.image" -}}
{{- printf "%s:%s" .Values.image.repository (toString (.Values.image.tag | default .Chart.AppVersion)) -}}
{{- end -}}

{{/* The Secret holding the bot's token and the OAuth secret: the user's own, or the chart's. */}}
{{- define "jukecord.secretName" -}}
{{- .Values.discord.existingSecret | default (include "jukecord.fullname" .) -}}
{{- end -}}

{{/* Whether there is a secret to mount at all. */}}
{{- define "jukecord.hasSecret" -}}
{{- if or .Values.discord.existingSecret .Values.discord.token .Values.discord.clientSecret -}}true{{- end -}}
{{- end -}}

{{/* Where the Secret's keys are mounted as files; jukecord reads them through JUKECORD_*_FILE. */}}
{{- define "jukecord.secretDir" -}}/run/secrets/jukecord{{- end -}}

{{/* Whether jukecord reads the bot's token: given in the values, or in an existing Secret (which must hold it). */}}
{{- define "jukecord.readsToken" -}}
{{- if or .Values.discord.existingSecret .Values.discord.token -}}true{{- end -}}
{{- end -}}

{{/*
Whether jukecord reads the OAuth secret: given in the values, or in an existing Secret when a client ID is set. An
existing Secret may hold the token alone, and the OAuth secret does nothing without the ID it belongs to, so without
an ID it is not read at all (a file that is not there would stop jukecord at start).
*/}}
{{- define "jukecord.readsClientSecret" -}}
{{- if .Values.discord.existingSecret -}}
{{- if or .Values.discord.clientId (include "jukecord.userSets" (list . "JUKECORD_DISCORD_CLIENT_ID")) -}}true{{- end -}}
{{- else if .Values.discord.clientSecret -}}true
{{- end -}}
{{- end -}}

{{/* Whether env or extraEnv sets a variable, so the chart does not set it a second time: (list . "NAME"). */}}
{{- define "jukecord.userSets" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- if hasKey $root.Values.env $name -}}true
{{- else -}}
{{- range $root.Values.extraEnv -}}{{- if eq .name $name -}}true{{- end -}}{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The address people reach the panel at, as the pod gets it: JUKECORD_PUBLIC_URL when extraEnv or env sets it, else
publicUrl, else the Ingress's host (https when the Ingress has TLS). Empty when there is none: no Ingress, or one
without a host or with a wildcard host, which names no single address. The Deployment and NOTES.txt both use it.
*/}}
{{- define "jukecord.publicUrl" -}}
{{- $url := "" -}}
{{- if .Values.publicUrl -}}
{{- $url = .Values.publicUrl -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host (not (hasPrefix "*" .Values.ingress.host)) -}}
{{- $url = printf "%s://%s" (ternary "https" "http" (gt (len (default list .Values.ingress.tls)) 0)) .Values.ingress.host -}}
{{- end -}}
{{- if hasKey .Values.env "JUKECORD_PUBLIC_URL" -}}
{{- $url = toString (index .Values.env "JUKECORD_PUBLIC_URL") -}}
{{- end -}}
{{- range .Values.extraEnv -}}
{{- if and (eq .name "JUKECORD_PUBLIC_URL") .value -}}{{- $url = .value -}}{{- end -}}
{{- end -}}
{{- $url -}}
{{- end -}}

{{/* Values that cannot work together, refused with a message that says what to change. */}}
{{- define "jukecord.validate" -}}
{{- if and .Values.discord.existingSecret (or .Values.discord.token .Values.discord.clientSecret) -}}
{{- fail "discord.existingSecret is set together with discord.token or discord.clientSecret, which would be ignored. Put the token and the OAuth secret in the Secret named by existingSecret and leave those two empty, or leave existingSecret empty to have the chart make the Secret from them." -}}
{{- end -}}
{{- end -}}
