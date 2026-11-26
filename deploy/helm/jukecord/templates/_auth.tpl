{{/*
Logging in through the host's identity provider (OIDC) and with directory accounts (LDAP): the values under auth,
given to the pods that serve browsers (the one pod; in split mode the edges, where `jukecord auth test-*` runs too) as
the JUKECORD_OIDC_* and JUKECORD_LDAP_* settings, and the client secret and the bind password as files. A private
authority of the provider's or the directory's is the chart's ca (jukecord.caEnv), which every connection trusts.
*/}}

{{/* Whether each way of logging in is on: its address set. */}}
{{- define "jukecord.oidcOn" -}}
{{- if .Values.auth.oidc.issuer -}}true{{- end -}}
{{- end -}}

{{- define "jukecord.ldapOn" -}}
{{- if .Values.auth.ldap.url -}}true{{- end -}}
{{- end -}}

{{/* Whether jukecord reads the OIDC client's secret (a public client has none) and the directory's bind password. */}}
{{- define "jukecord.readsOidcSecret" -}}
{{- if and (include "jukecord.oidcOn" .) (or .Values.auth.oidc.clientSecret .Values.auth.oidc.existingSecret) -}}true{{- end -}}
{{- end -}}

{{- define "jukecord.readsLdapPassword" -}}
{{- if and (include "jukecord.ldapOn" .) (or .Values.auth.ldap.bindPassword .Values.auth.ldap.existingSecret) -}}true{{- end -}}
{{- end -}}

{{/* The Secret the chart makes for the two secrets given in the values. */}}
{{- define "jukecord.authSecretName" -}}
{{- printf "%s-auth" (include "jukecord.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Whether the chart makes that Secret: a secret given in the values for a way that is on. */}}
{{- define "jukecord.makesAuthSecret" -}}
{{- if and (include "jukecord.oidcOn" .) .Values.auth.oidc.clientSecret (not .Values.auth.oidc.existingSecret) -}}true
{{- else if and (include "jukecord.ldapOn" .) .Values.auth.ldap.bindPassword (not .Values.auth.ldap.existingSecret) -}}true
{{- end -}}
{{- end -}}

{{/* Where the two secrets are mounted. */}}
{{- define "jukecord.authDir" -}}/run/secrets/jukecord-auth{{- end -}}

{{/*
Every variable the chart sets from auth, with the value it comes from: env and extraEnv may not set them (see
jukecord.validate). The packaging tests check this list against src/auth/settings.ts.
*/}}
{{- define "jukecord.authVariables" -}}
{{- $from := dict -}}
{{- $_ := set $from "JUKECORD_OIDC_ISSUER" "auth.oidc.issuer" -}}
{{- $_ := set $from "JUKECORD_OIDC_CLIENT_ID" "auth.oidc.clientId" -}}
{{- $_ := set $from "JUKECORD_OIDC_CLIENT_SECRET" "auth.oidc.clientSecret or auth.oidc.existingSecret" -}}
{{- $_ := set $from "JUKECORD_OIDC_CLIENT_SECRET_FILE" "auth.oidc.clientSecret or auth.oidc.existingSecret" -}}
{{- $_ := set $from "JUKECORD_OIDC_SCOPES" "auth.oidc.scopes" -}}
{{- $_ := set $from "JUKECORD_OIDC_GROUPS_CLAIM" "auth.oidc.groupsClaim" -}}
{{- $_ := set $from "JUKECORD_OIDC_ADMIN_GROUPS" "auth.oidc.adminGroups" -}}
{{- $_ := set $from "JUKECORD_OIDC_CONTROL_GROUPS" "auth.oidc.controlGroups" -}}
{{- $_ := set $from "JUKECORD_OIDC_READ_GROUPS" "auth.oidc.readGroups" -}}
{{- $_ := set $from "JUKECORD_OIDC_LABEL" "auth.oidc.label" -}}
{{- $_ := set $from "JUKECORD_OIDC_DISCORD_CLAIM" "auth.oidc.discordClaim" -}}
{{- $_ := set $from "JUKECORD_LDAP_URL" "auth.ldap.url" -}}
{{- $_ := set $from "JUKECORD_LDAP_STARTTLS" "auth.ldap.startTls" -}}
{{- $_ := set $from "JUKECORD_LDAP_BIND_DN" "auth.ldap.bindDn" -}}
{{- $_ := set $from "JUKECORD_LDAP_BIND_PASSWORD" "auth.ldap.bindPassword or auth.ldap.existingSecret" -}}
{{- $_ := set $from "JUKECORD_LDAP_BIND_PASSWORD_FILE" "auth.ldap.bindPassword or auth.ldap.existingSecret" -}}
{{- $_ := set $from "JUKECORD_LDAP_BASE_DN" "auth.ldap.baseDn" -}}
{{- $_ := set $from "JUKECORD_LDAP_USER_FILTER" "auth.ldap.userFilter" -}}
{{- $_ := set $from "JUKECORD_LDAP_GROUP_FILTER" "auth.ldap.groupFilter" -}}
{{- $_ := set $from "JUKECORD_LDAP_GROUP_BASE_DN" "auth.ldap.groupBaseDn" -}}
{{- $_ := set $from "JUKECORD_LDAP_NESTED_GROUPS" "auth.ldap.nestedGroups" -}}
{{- $_ := set $from "JUKECORD_LDAP_ADMIN_GROUPS" "auth.ldap.adminGroups" -}}
{{- $_ := set $from "JUKECORD_LDAP_CONTROL_GROUPS" "auth.ldap.controlGroups" -}}
{{- $_ := set $from "JUKECORD_LDAP_READ_GROUPS" "auth.ldap.readGroups" -}}
{{- $_ := set $from "JUKECORD_LDAP_TIMEOUT" "auth.ldap.timeout" -}}
{{- $_ := set $from "JUKECORD_LDAP_LABEL" "auth.ldap.label" -}}
{{- toYaml $from -}}
{{- end -}}

{{/* The values of auth that cannot work together, refused with what to change (called by jukecord.validate). */}}
{{- define "jukecord.validateAuth" -}}
{{- $oidc := .Values.auth.oidc -}}
{{- $ldap := .Values.auth.ldap -}}
{{- if not $oidc.issuer -}}
{{- range $key := list "clientId" "clientSecret" "existingSecret" "adminGroups" "controlGroups" "readGroups" "discordClaim" -}}
{{- if index $oidc $key -}}
{{- fail (printf "auth.oidc.%s is set but auth.oidc.issuer is not: logging in through SSO is off until its issuer is set." $key) -}}
{{- end -}}
{{- end -}}
{{- else -}}
{{- if not $oidc.clientId -}}
{{- fail "auth.oidc.issuer is set but auth.oidc.clientId is not: the provider knows jukecord by its client ID." -}}
{{- end -}}
{{- if not (or $oidc.adminGroups $oidc.controlGroups $oidc.readGroups) -}}
{{- fail "auth.oidc needs who may log in: adminGroups, controlGroups or readGroups (a list; \"*\" lets in everyone the provider knows)." -}}
{{- end -}}
{{- end -}}
{{- if not $ldap.url -}}
{{- range $key := list "bindDn" "bindPassword" "existingSecret" "baseDn" "groupFilter" "groupBaseDn" "adminGroups" "controlGroups" "readGroups" -}}
{{- if index $ldap $key -}}
{{- fail (printf "auth.ldap.%s is set but auth.ldap.url is not: logging in with a directory account is off until its address is set." $key) -}}
{{- end -}}
{{- end -}}
{{- else -}}
{{- if not $ldap.baseDn -}}
{{- fail "auth.ldap.url is set but auth.ldap.baseDn is not: jukecord looks for people under it." -}}
{{- end -}}
{{- if not (or $ldap.adminGroups $ldap.controlGroups $ldap.readGroups) -}}
{{- fail "auth.ldap needs who may log in: adminGroups, controlGroups or readGroups (a list; \"*\" lets in everyone the directory knows)." -}}
{{- end -}}
{{- if ne (not $ldap.bindDn) (not (or $ldap.bindPassword $ldap.existingSecret)) -}}
{{- fail "auth.ldap.bindDn and its password (auth.ldap.bindPassword, or auth.ldap.existingSecret) go together: set both for a service account, or neither for an anonymous search." -}}
{{- end -}}
{{- end -}}
{{- if and $oidc.clientSecret $oidc.existingSecret -}}
{{- fail "auth.oidc.clientSecret and auth.oidc.existingSecret are both set; set one: the secret in the values, or under the key oidcClientSecret of a Secret of yours." -}}
{{- end -}}
{{- if and $ldap.bindPassword $ldap.existingSecret -}}
{{- fail "auth.ldap.bindPassword and auth.ldap.existingSecret are both set; set one: the password in the values, or under the key ldapBindPassword of a Secret of yours." -}}
{{- end -}}
{{- end -}}

{{/* The settings of logging in, for the container's env (empty when both ways are off). */}}
{{- define "jukecord.authEnv" -}}
{{- $oidc := .Values.auth.oidc -}}
{{- $ldap := .Values.auth.ldap -}}
{{- if include "jukecord.oidcOn" . }}
# Logging in through the identity provider (auth.oidc).
- name: JUKECORD_OIDC_ISSUER
  value: {{ $oidc.issuer | quote }}
- name: JUKECORD_OIDC_CLIENT_ID
  value: {{ $oidc.clientId | quote }}
{{- if include "jukecord.readsOidcSecret" . }}
# The client's secret as a file (the volume auth), not as a variable.
- name: JUKECORD_OIDC_CLIENT_SECRET_FILE
  value: {{ include "jukecord.authDir" . }}/oidcClientSecret
{{- end }}
{{- with $oidc.scopes }}
- name: JUKECORD_OIDC_SCOPES
  value: {{ join " " . | quote }}
{{- end }}
{{- with $oidc.groupsClaim }}
- name: JUKECORD_OIDC_GROUPS_CLAIM
  value: {{ . | quote }}
{{- end }}
{{- with $oidc.adminGroups }}
- name: JUKECORD_OIDC_ADMIN_GROUPS
  value: {{ join ";" . | quote }}
{{- end }}
{{- with $oidc.controlGroups }}
- name: JUKECORD_OIDC_CONTROL_GROUPS
  value: {{ join ";" . | quote }}
{{- end }}
{{- with $oidc.readGroups }}
- name: JUKECORD_OIDC_READ_GROUPS
  value: {{ join ";" . | quote }}
{{- end }}
{{- with $oidc.label }}
- name: JUKECORD_OIDC_LABEL
  value: {{ . | quote }}
{{- end }}
{{- with $oidc.discordClaim }}
- name: JUKECORD_OIDC_DISCORD_CLAIM
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- if include "jukecord.ldapOn" . }}
# Logging in with a directory account (auth.ldap).
- name: JUKECORD_LDAP_URL
  value: {{ $ldap.url | quote }}
{{- if $ldap.startTls }}
- name: JUKECORD_LDAP_STARTTLS
  value: "yes"
{{- end }}
{{- with $ldap.bindDn }}
- name: JUKECORD_LDAP_BIND_DN
  value: {{ . | quote }}
{{- end }}
{{- if include "jukecord.readsLdapPassword" . }}
# The service account's password as a file (the volume auth), not as a variable.
- name: JUKECORD_LDAP_BIND_PASSWORD_FILE
  value: {{ include "jukecord.authDir" . }}/ldapBindPassword
{{- end }}
- name: JUKECORD_LDAP_BASE_DN
  value: {{ $ldap.baseDn | quote }}
{{- with $ldap.userFilter }}
- name: JUKECORD_LDAP_USER_FILTER
  value: {{ . | quote }}
{{- end }}
{{- with $ldap.groupFilter }}
- name: JUKECORD_LDAP_GROUP_FILTER
  value: {{ . | quote }}
{{- end }}
{{- with $ldap.groupBaseDn }}
- name: JUKECORD_LDAP_GROUP_BASE_DN
  value: {{ . | quote }}
{{- end }}
{{- if $ldap.nestedGroups }}
- name: JUKECORD_LDAP_NESTED_GROUPS
  value: "yes"
{{- end }}
{{- with $ldap.adminGroups }}
- name: JUKECORD_LDAP_ADMIN_GROUPS
  value: {{ join ";" . | quote }}
{{- end }}
{{- with $ldap.controlGroups }}
- name: JUKECORD_LDAP_CONTROL_GROUPS
  value: {{ join ";" . | quote }}
{{- end }}
{{- with $ldap.readGroups }}
- name: JUKECORD_LDAP_READ_GROUPS
  value: {{ join ";" . | quote }}
{{- end }}
{{- with $ldap.timeout }}
- name: JUKECORD_LDAP_TIMEOUT
  value: {{ . | quote }}
{{- end }}
{{- with $ldap.label }}
- name: JUKECORD_LDAP_LABEL
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Where the two secrets are mounted in the container (empty when there are none). */}}
{{- define "jukecord.authMounts" -}}
{{- if or (include "jukecord.readsOidcSecret" .) (include "jukecord.readsLdapPassword" .) }}
- name: auth
  mountPath: {{ include "jukecord.authDir" . }}
  readOnly: true
{{- end }}
{{- end -}}

{{/*
The volume of the two secrets: readable by jukecord's group only; not optional: a Secret without the key, or a
misspelt name, keeps the pod from starting with an event that names it.
*/}}
{{- define "jukecord.authVolumes" -}}
{{- if or (include "jukecord.readsOidcSecret" .) (include "jukecord.readsLdapPassword" .) }}
- name: auth
  projected:
    defaultMode: 0440
    sources:
      {{- if include "jukecord.readsOidcSecret" . }}
      - secret:
          name: {{ .Values.auth.oidc.existingSecret | default (include "jukecord.authSecretName" .) }}
          items:
            - key: oidcClientSecret
              path: oidcClientSecret
          optional: false
      {{- end }}
      {{- if include "jukecord.readsLdapPassword" . }}
      - secret:
          name: {{ .Values.auth.ldap.existingSecret | default (include "jukecord.authSecretName" .) }}
          items:
            - key: ldapBindPassword
              path: ldapBindPassword
          optional: false
      {{- end }}
{{- end }}
{{- end -}}

{{/* A changed setting or secret of the values restarts the pods that log people in, which read them only at start. */}}
{{- define "jukecord.authChecksum" -}}
checksum/auth: {{ toJson .Values.auth | sha256sum | trunc 16 }}
{{- end -}}

{{/* The rules out to the identity provider and the directory, for the pods that log people in (auth.egressTo). */}}
{{- define "jukecord.authEgress" -}}
{{- with .Values.auth.egressTo }}
# The identity provider and the directory, where auth.egressTo says they are (logins happen in these pods).
{{ toYaml . }}
{{- end }}
{{- end -}}
