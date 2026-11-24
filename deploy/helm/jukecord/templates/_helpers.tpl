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
find the pod by them). podLabels may be missing altogether: an upgrade with --reuse-values from a chart before it
keeps the old values, which have none. */}}
{{- define "jukecord.podLabels" -}}
{{- toYaml (merge (include "jukecord.labels" . | fromYaml) (.Values.podLabels | default dict)) -}}
{{- end -}}

{{/*
The labels of one part of a split release ((list . "core") or (list . "edge")): every label of the chart's, with the
part as the component. Its pods are selected by the selector labels and the component, so the panel's Service finds
the edges and the core's Service the core.
*/}}
{{- define "jukecord.partLabels" -}}
{{- $root := index . 0 -}}
{{- toYaml (merge (dict "app.kubernetes.io/component" (index . 1)) (include "jukecord.labels" $root | fromYaml)) -}}
{{- end -}}

{{- define "jukecord.partSelector" -}}
{{- $root := index . 0 -}}
{{ include "jukecord.selectorLabels" $root }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* A part's pods: podLabels from the values under the part's own labels, which win. */}}
{{- define "jukecord.partPodLabels" -}}
{{- $root := index . 0 -}}
{{- toYaml (merge (include "jukecord.partLabels" . | fromYaml) ($root.Values.podLabels | default dict)) -}}
{{- end -}}

{{/* The core's name, which its Service has too: the edges reach its internal port by it. */}}
{{- define "jukecord.coreName" -}}
{{- printf "%s-core" (include "jukecord.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "jukecord.edgeName" -}}
{{- printf "%s-edge" (include "jukecord.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The Secret the chart makes for split mode: the bus's address when given here, and the internal secret. */}}
{{- define "jukecord.splitSecretName" -}}
{{- printf "%s-split" (include "jukecord.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Where split mode's own secrets are mounted, as files that jukecord reads through JUKECORD_*_FILE: the bus's address
and the internal secret, each from a Secret of the user's or the chart's. The database's address is mounted as in
single mode (jukecord.databaseVolume).
*/}}
{{- define "jukecord.splitDir" -}}/run/secrets/jukecord-split{{- end -}}

{{/* The environment both parts of a split release read: the files of the secrets, and the settings of the values. */}}
{{- define "jukecord.splitEnv" -}}
- name: JUKECORD_HOST
  value: "0.0.0.0"
- name: JUKECORD_PORT
  value: "8795"
- name: JUKECORD_DATA_DIR
  value: /data
# The database's address as a file (it holds a password), as in single mode.
- name: JUKECORD_DATABASE_URL_FILE
  value: {{ include "jukecord.databaseDir" . }}/url
{{- if include "jukecord.readsMetricsToken" . }}
# The token a scraper from outside the cluster's network shows for /metrics (metrics.token).
- name: JUKECORD_METRICS_TOKEN_FILE
  value: {{ include "jukecord.secretDir" . }}/metricsToken
{{- end }}
- name: JUKECORD_BUS_URL_FILE
  value: {{ include "jukecord.splitDir" . }}/bus-url
- name: JUKECORD_INTERNAL_SECRET_FILE
  value: {{ include "jukecord.splitDir" . }}/internal-secret
{{- if not (include "jukecord.userSets" (list . "JUKECORD_PUBLIC_URL")) }}
{{- with include "jukecord.publicUrl" . }}
- name: JUKECORD_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- if and .Values.discord.clientId (not (include "jukecord.userSets" (list . "JUKECORD_DISCORD_CLIENT_ID"))) }}
- name: JUKECORD_DISCORD_CLIENT_ID
  value: {{ .Values.discord.clientId | quote }}
{{- end }}
{{- range $name, $value := .Values.env }}
- name: {{ $name }}
  value: {{ toString $value | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* The projected volume of split mode's own secrets (the bus, the internal secret). */}}
{{- define "jukecord.splitSecrets" -}}
- name: split
  projected:
    defaultMode: 0440
    sources:
      - secret:
          name: {{ .Values.bus.existingSecret | default (include "jukecord.splitSecretName" .) }}
          items:
            - key: {{ ternary "url" "bus-url" (not (empty .Values.bus.existingSecret)) }}
              path: bus-url
      - secret:
          name: {{ .Values.split.existingSecret | default (include "jukecord.splitSecretName" .) }}
          items:
            - key: {{ ternary "internalSecret" "internal-secret" (not (empty .Values.split.existingSecret)) }}
              path: internal-secret
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

{{/* Whether jukecord reads a metrics token: given in the values, or in an existing Secret (which must hold it). */}}
{{- define "jukecord.readsMetricsToken" -}}
{{- if or .Values.metrics.existingSecret .Values.metrics.token -}}true{{- end -}}
{{- end -}}

{{/* The Secret holding the metrics token: the user's own, or the chart's. */}}
{{- define "jukecord.metricsSecretName" -}}
{{- .Values.metrics.existingSecret | default (include "jukecord.fullname" .) -}}
{{- end -}}

{{/* Whether the chart makes a Secret: for the Discord secrets or the metrics token given in the values. */}}
{{- define "jukecord.makesSecret" -}}
{{- if and (not .Values.discord.existingSecret) (or .Values.discord.token .Values.discord.clientSecret) -}}true
{{- else if and (not .Values.metrics.existingSecret) .Values.metrics.token -}}true
{{- end -}}
{{- end -}}

{{/* Whether there is a file to mount from a Secret at all. */}}
{{- define "jukecord.mountsSecrets" -}}
{{- if or (include "jukecord.readsToken" .) (include "jukecord.readsClientSecret" .) (include "jukecord.readsMetricsToken" .) -}}true{{- end -}}
{{- end -}}

{{/*
Whether to make the ServiceMonitor: asked for, and the cluster has the Prometheus Operator's CRD (helm install and
upgrade ask the cluster), or forced (helm template asks none, and would never make it).
*/}}
{{- define "jukecord.serviceMonitor" -}}
{{- $monitor := .Values.metrics.serviceMonitor -}}
{{- if and $monitor.enabled (or $monitor.force (.Capabilities.APIVersions.Has "monitoring.coreos.com/v1/ServiceMonitor")) -}}true{{- end -}}
{{- end -}}

{{/* Whether jukecord reads its database's address from a Secret: given in the values, or in a Secret of yours. */}}
{{- define "jukecord.readsDatabase" -}}
{{- if or .Values.database.url .Values.database.existingSecret -}}true{{- end -}}
{{- end -}}

{{/* The Secret holding the database's address under the key url: the user's own, or the chart's. */}}
{{- define "jukecord.databaseSecretName" -}}
{{- .Values.database.existingSecret | default (printf "%s-database" (include "jukecord.fullname" .) | trunc 63 | trimSuffix "-") -}}
{{- end -}}

{{/* Where the database's address is mounted as a file; jukecord reads it through JUKECORD_DATABASE_URL_FILE. */}}
{{- define "jukecord.databaseDir" -}}/run/secrets/jukecord-database{{- end -}}

{{/*
The database's address as a file, readable by jukecord's group (the pod's fsGroup) only: one volume for the one pod and
for both parts of split mode. Not optional: a Secret without it (or a misspelt name) keeps the pod from starting, with
an event that names the key.
*/}}
{{- define "jukecord.databaseVolume" -}}
- name: database
  secret:
    secretName: {{ include "jukecord.databaseSecretName" . }}
    defaultMode: 0440
    items:
      - key: url
        path: url
{{- end -}}

{{/* The pod's annotations for a changed database (the pod opens it only when it starts) and for a Prometheus that
finds its targets by annotation (metrics.podAnnotations; one set in podAnnotations wins). */}}
{{- define "jukecord.databaseChecksum" -}}
checksum/database: {{ printf "%s/%s" .Values.database.url .Values.database.existingSecret | sha256sum | trunc 16 }}
{{- end -}}

{{- define "jukecord.scrapeAnnotations" -}}
{{- if .Values.metrics.podAnnotations -}}
{{- $lines := list -}}
{{- range $key, $value := dict "prometheus.io/scrape" "true" "prometheus.io/port" "8795" "prometheus.io/path" "/metrics" -}}
{{- if not (hasKey ($.Values.podAnnotations | default dict) $key) -}}
{{- $lines = append $lines (printf "%s: %s" $key ($value | quote)) -}}
{{- end -}}
{{- end -}}
{{- join "\n" $lines -}}
{{- end -}}
{{- end -}}

{{/* Whether env or extraEnv sets a variable, so the chart does not set it a second time: (list . "NAME"). */}}
{{- define "jukecord.userSets" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- if hasKey ($root.Values.env | default dict) $name -}}true
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
{{- if hasKey (.Values.env | default dict) "JUKECORD_PUBLIC_URL" -}}
{{- $url = toString (index .Values.env "JUKECORD_PUBLIC_URL") -}}
{{- end -}}
{{- range .Values.extraEnv -}}
{{- if and (eq .name "JUKECORD_PUBLIC_URL") .value -}}{{- $url = .value -}}{{- end -}}
{{- end -}}
{{- if include "jukecord.publicUrlElsewhere" . -}}{{- $url = "" -}}{{- end -}}
{{- $url -}}
{{- end -}}

{{/* Whether jukecord believes X-Forwarded-For: the chart sets that for the Ingress unless env or extraEnv sets it. */}}
{{- define "jukecord.trustsProxy" -}}
{{- if include "jukecord.userSets" (list . "JUKECORD_TRUST_PROXY") -}}
{{- $set := toString (index (.Values.env | default dict) "JUKECORD_TRUST_PROXY" | default "") -}}
{{- if not (has $set (list "" "false" "0")) -}}true{{- end -}}
{{- else if .Values.ingress.enabled -}}true
{{- end -}}
{{- end -}}

{{/* Whether the pod's public address comes from where the chart cannot read it (extraEnv's valueFrom). */}}
{{- define "jukecord.publicUrlElsewhere" -}}
{{- range .Values.extraEnv -}}{{- if and (eq .name "JUKECORD_PUBLIC_URL") .valueFrom -}}true{{- end -}}{{- end -}}
{{- end -}}

{{/* Values that cannot work together, refused with a message that says what to change. */}}
{{- define "jukecord.validate" -}}
{{- $chartSets := dict "JUKECORD_HOST" "service.port and the pod's address" "JUKECORD_PORT" "service.port" "JUKECORD_DATA_DIR" "persistence" "JUKECORD_DISCORD_TOKEN_FILE" "discord.token or discord.existingSecret" "JUKECORD_DISCORD_CLIENT_SECRET_FILE" "discord.clientSecret or discord.existingSecret" "JUKECORD_METRICS_TOKEN_FILE" "metrics.token or metrics.existingSecret" "JUKECORD_DATABASE_URL_FILE" "database.url or database.existingSecret" "JUKECORD_ROLE" "mode" "JUKECORD_BUS_URL" "bus.url or bus.existingSecret" "JUKECORD_BUS_URL_FILE" "bus.url or bus.existingSecret" "JUKECORD_INTERNAL_SECRET" "split.existingSecret" "JUKECORD_INTERNAL_SECRET_FILE" "split.existingSecret" "JUKECORD_INTERNAL_PORT" "the core's Service" "JUKECORD_CORE_URL" "the core's Service" -}}
{{- if eq .Values.mode "split" -}}
{{- if not (or .Values.database.url .Values.database.existingSecret) -}}
{{- fail "mode: split needs a database every service shares: database.url (postgres://... or mysql://...) or database.existingSecret (a Secret with the key url)." -}}
{{- end -}}
{{- if hasPrefix "sqlite:" (toString .Values.database.url) -}}
{{- fail "mode: split needs a database every service shares, and a SQLite file is one pod's: database.url takes a postgres:// or mysql:// address." -}}
{{- end -}}
{{- if not (or .Values.bus.url .Values.bus.existingSecret) -}}
{{- fail "mode: split needs the Redis or Valkey server the services talk through: bus.url (redis://...) or bus.existingSecret (a Secret with the key url)." -}}
{{- end -}}
{{- if and .Values.bus.url .Values.bus.existingSecret -}}
{{- fail "bus.url and bus.existingSecret are both set; set one of them." -}}
{{- end -}}
{{- end -}}
{{- $names := list -}}
{{- range $name, $_ := (.Values.env | default dict) -}}{{- $names = append $names (list "env" $name) -}}{{- end -}}
{{- range (.Values.extraEnv | default list) -}}{{- $names = append $names (list "extraEnv" .name) -}}{{- end -}}
{{- range $names -}}
{{- $where := index . 0 -}}
{{- $name := index . 1 -}}
{{- if has $name (list "JUKECORD_DISCORD_TOKEN" "JUKECORD_DISCORD_CLIENT_SECRET") -}}
{{- fail (printf "%s: %s is not set here. The bot's token goes in discord.token and the OAuth secret in discord.clientSecret, or both in a Secret named by discord.existingSecret; the chart gives them to jukecord as files." $where $name) -}}
{{- end -}}
{{- if eq $name "JUKECORD_METRICS_TOKEN" -}}
{{- fail (printf "%s: JUKECORD_METRICS_TOKEN is not set here. The metrics token goes in metrics.token, or in a Secret named by metrics.existingSecret (key metricsToken); the chart gives it to jukecord as a file and to the ServiceMonitor." $where) -}}
{{- end -}}
{{- if eq $name "JUKECORD_DATABASE_URL" -}}
{{- fail (printf "%s: JUKECORD_DATABASE_URL is not set here. The database's address goes in database.url, or under the key url of a Secret named by database.existingSecret; the chart gives it to jukecord as a file (it holds a password)." $where) -}}
{{- end -}}
{{- if hasKey $chartSets $name -}}
{{- fail (printf "%s: %s is set by the chart (from %s); leave it out." $where $name (index $chartSets $name)) -}}
{{- end -}}
{{- end -}}
{{- range (.Values.extraEnv | default list) -}}
{{- if hasKey ($.Values.env | default dict) .name -}}
{{- fail (printf "%s is set in both env and extraEnv; set it in one of them." .name) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.discord.clientSecret (not (or .Values.discord.clientId (include "jukecord.userSets" (list . "JUKECORD_DISCORD_CLIENT_ID")))) -}}
{{- fail "discord.clientSecret is set without discord.clientId. Logging in with Discord needs both: the application's ID (discord.clientId, quoted) and its OAuth2 secret; leave both empty for host logins only." -}}
{{- end -}}
{{- if and .Values.database.url .Values.database.existingSecret -}}
{{- fail "database.url and database.existingSecret are both set; set one: the address in the values, or under the key url of a Secret of yours." -}}
{{- end -}}
{{- if and .Values.discord.existingSecret (or .Values.discord.token .Values.discord.clientSecret) -}}
{{- fail "discord.existingSecret is set together with discord.token or discord.clientSecret, which would be ignored. Put the token and the OAuth secret in the Secret named by existingSecret and leave those two empty, or leave existingSecret empty to have the chart make the Secret from them." -}}
{{- end -}}
{{- if and .Values.metrics.existingSecret .Values.metrics.token -}}
{{- fail "metrics.existingSecret is set together with metrics.token, which would be ignored. Put the token in the Secret named by existingSecret (key metricsToken) and leave metrics.token empty, or leave existingSecret empty to have the chart make the Secret from it." -}}
{{- end -}}
{{- end -}}

{{/* The rules of split mode's egress that both parts share: DNS, the internet but none of the cluster's private
networks, and the database and the bus (egressTo, or the release's namespace on their usual ports). */}}
{{- define "jukecord.splitEgress" -}}
# Names, from the cluster's DNS.
- ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
# The internet, any port (Discord, its voice servers over UDP, the sites tracks come from; for an edge, Discord's login).
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          {{- toYaml .Values.networkPolicy.privateRanges | nindent 10 }}
    - ipBlock:
        cidr: ::/0
        except:
          - fc00::/7
          - fe80::/10
{{ include "jukecord.serviceEgress" . }}
{{- end }}

{{/*
The rule out to what jukecord's pods use in the cluster's private range, the same in both modes: the database, and
in split mode the bus. The rules given (networkPolicy.egressTo), or any pod of the release's namespace on PostgreSQL's
and MySQL's ports (and Redis's in split mode). None for the one pod on its SQLite file.
*/}}
{{- define "jukecord.serviceEgress" -}}
{{- if or (include "jukecord.readsDatabase" .) (eq .Values.mode "split") }}
{{- with .Values.networkPolicy.egressTo }}
# Where networkPolicy.egressTo says the database{{ if eq $.Values.mode "split" }} and the bus are{{ else }} is{{ end }}.
{{ toYaml . }}
{{- else }}
# The database{{ if eq .Values.mode "split" }} and the bus{{ end }}, in the release's namespace (networkPolicy.egressTo names {{ if eq .Values.mode "split" }}them{{ else }}it{{ end }} elsewhere).
- to:
    - podSelector: {}
  ports:
    - port: 5432
      protocol: TCP
    - port: 3306
      protocol: TCP
    {{- if eq .Values.mode "split" }}
    - port: 6379
      protocol: TCP
    {{- end }}
{{- end }}
{{- end }}
{{- end -}}
