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

{{/* Every label of the chart's objects. */}}
{{- define "jukecord.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "jukecord.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
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
{{- if or .Values.discord.clientId (hasKey .Values.env "JUKECORD_DISCORD_CLIENT_ID") -}}true{{- end -}}
{{- else if .Values.discord.clientSecret -}}true
{{- end -}}
{{- end -}}
