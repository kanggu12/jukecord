# jukecord on Kubernetes

For people who run jukecord on a cluster: installing the Helm chart, its values, the Ingress and the NetworkPolicy,
security, memory, a database server, logins through your own accounts, monitoring, a split into services, upgrades,
backups and k3s.

The chart runs one pod by default, with a Service, a volume for the database and the cache, and optionally an Ingress.
It never runs a second replica of that pod: a bot token allows one Discord session. In split mode it runs one core and
as many edges as you like instead ([split into services](#split-into-services)). It is published as an OCI chart.

## Install

1. Write the values in a file of your own, `jukecord-values.yaml`, which every later `helm upgrade` is given again:

   ```yaml
   discord:
     existingSecret: jukecord-discord
     clientId: "YOUR_APPLICATION_ID"
   publicUrl: https://music.example.com
   ingress:
     enabled: true
     host: music.example.com
     # The certificate for the host: a TLS Secret of that name, made by cert-manager or with kubectl create secret tls.
     tls:
       - secretName: jukecord-tls
         hosts: [music.example.com]
   ```

2. Make the Secret, install the chart and make a one-time login link for the host:

   ```bash
   token=YOUR_BOT_TOKEN secret=YOUR_OAUTH_SECRET
   kubectl create namespace jukecord
   kubectl -n jukecord create secret generic jukecord-discord \
     --from-literal=token="$token" --from-literal=clientSecret="$secret"
   helm install jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
   kubectl -n jukecord exec deploy/jukecord -- jukecord link
   ```

- `kubectl -n jukecord exec deploy/jukecord -- jukecord doctor` checks every part jukecord needs.
- Without TLS on the Ingress or in front of its controller, logins cross the network unencrypted; the notes Helm prints
  after the install say so.
- jukecord reads the token and the OAuth secret when it starts. A new token in the Secret takes effect after
  `kubectl -n jukecord rollout restart deploy/jukecord`; a new token in the values restarts the pod with the
  `helm upgrade` that brings it.

## Values

| Value                                                                      |                       Default                       | Sets                                                                  |
| :------------------------------------------------------------------------- | :-------------------------------------------------: | :-------------------------------------------------------------------- |
| `image.repository`, `image.tag`                                            | `ghcr.io/kanggu12/jukecord`, the chart's appVersion | the image: another registry's copy, or your own build                 |
| `imagePullSecrets`                                                         |                        `[]`                         | Secrets to pull the image with (helm test's pod uses them too)        |
| `discord.existingSecret`                                                   |                                                     | a Secret with `token` and `clientSecret`                              |
| `discord.token`, `discord.clientSecret`                                    |                                                     | the same in the values; the chart makes the Secret                    |
| `discord.clientId`                                                         |                                                     | the application's ID (`--set-string`: it is a long number)            |
| `publicUrl`                                                                |                 the Ingress's host                  | the panel's address, for logins and the bot's links                   |
| `database.url`, `database.existingSecret`                                  |                SQLite in the volume                 | [a database server](#a-database-server)                               |
| `auth.oidc.*`, `auth.ldap.*`, `auth.ca`, `auth.egressTo`                   |                         off                         | [logins through your own accounts](#logins-through-your-own-accounts) |
| `metrics.token`, `.existingSecret`, `.podAnnotations`, `.serviceMonitor.*` |                         off                         | [monitoring](#monitoring)                                             |
| `mode`, `bus.*`, `split.*`                                                 |                      `single`                       | [split into services](#split-into-services)                           |
| `env`                                                                      |                        `{}`                         | any [setting](README.md#settings) by name, as a string                |
| `extraEnv`                                                                 |                        `[]`                         | more variables as Kubernetes writes them                              |
| `ingress.enabled`, `.host`, `.className`, `.annotations`, `.tls`           |                         off                         | [the Ingress](#the-ingress)                                           |
| `persistence.enabled`, `.size`, `.storageClass`, `.existingClaim`          |                      on, `5Gi`                      | the data volume, kept when the release is uninstalled                 |
| `networkPolicy.enabled`, `.ingressFrom`, `.egressTo`, `.privateRanges`     |                         on                          | [the NetworkPolicy](#the-networkpolicy)                               |
| `resources`                                                                |              250m, 512Mi; limit 1536Mi              | requests and limits ([memory and CPU](#memory-and-cpu))               |
| `service.type`, `.port`                                                    |                 `ClusterIP`, `8795`                 | the Service                                                           |
| `podLabels`, `podAnnotations`                                              |                        `{}`                         | more for the pod; the chart's own labels win                          |
| `podSecurityContext`, `securityContext`                                    |       user 10001, read-only, no capabilities        | [security](#security)                                                 |
| `nodeSelector`, `tolerations`, `affinity`                                  |                                                     | where the pod may run; helm test's pod follows the first two          |

- The pod does not start without the Secret's `token`; its `clientSecret` is read when a client ID is set.
- `publicUrl` defaults to the Ingress's host, with https when the Ingress has TLS.
- `env` takes values such as `JUKECORD_CACHE_MAX: 8GiB`; quote numbers and IDs. The chart sets the port, the
  listening address, the data directory and the `*_FILE` secrets; the token and the OAuth secret go in `discord`, the
  database's address in `database` and the logins' settings in `auth`: the schema refuses all of these in `env` and in
  `extraEnv`.
- `extraEnv` takes `name` with `value`, or `valueFrom` a ConfigMap: `NODE_OPTIONS`, `TZ`, `HTTPS_PROXY`.
- Every value is checked against the chart's `values.schema.json`, so a misspelt key fails the install.

## The Ingress

WebSocket (`/api/v1/events`) passes through ingress-nginx, Traefik and most others as it is. It needs a long read
timeout, since the panel keeps that connection open; with ingress-nginx:

```yaml
ingress:
  enabled: true
  className: nginx
  host: music.example.com
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  tls:
    - secretName: jukecord-tls
      hosts: [music.example.com]
```

- With the Ingress on, jukecord believes one proxy's `X-Forwarded-For` (for the login limiter), unless `env` or
  `extraEnv` sets `JUKECORD_TRUST_PROXY` otherwise, so any pod that reaches the port directly could put any address in
  that header ([who may reach it](#the-networkpolicy)).
- The Ingress sends every path to jukecord, `/metrics` too. jukecord answers it with a 404 to a request that came
  through the Ingress (it carries `X-Forwarded-For`), unless it shows the metrics token: `/metrics` is meant for a
  Prometheus inside the cluster, reading it from the Service ([monitoring](#monitoring)).

## The NetworkPolicy

In: the panel's port only. Out: DNS, and the internet on any port (Discord's voice servers use UDP on ports they
choose), but none of the private ranges in `networkPolicy.privateRanges`, so jukecord cannot reach other services in
the cluster, except the ones its values name: the database and the bus (`networkPolicy.egressTo`), the identity
provider and the directory (`auth.egressTo`).

- If your cluster's pods or services use other ranges, list them.
- For jukecord to reach something else private (a proxy to the internet, say), turn the policy off or add your own.
  Fetching tracks from a private address also needs `JUKECORD_ALLOW_PRIVATE_ADDRESSES: "true"` in `env`: jukecord
  refuses those addresses on its own as well.

Anyone in the cluster may reach the panel's port unless `networkPolicy.ingressFrom` names who may, as NetworkPolicy
peers. Behind an Ingress, name its controller, so the `X-Forwarded-For` jukecord believes can only come from it.
helm test's pod is let in as well, and a Prometheus that reads `/metrics` needs a peer of its own. For ingress-nginx:

```yaml
networkPolicy:
  ingressFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
```

## Security

- The pod runs as user 10001 with a read-only root filesystem, no capabilities, no privilege escalation, the default
  seccomp profile, no Kubernetes API token and no Service environment variables.
- The image writes only to `/data` and `/tmp`.
- The bot's token and the OAuth secret are mounted from the Secret as files in `/run/secrets/jukecord`, readable by
  jukecord's group only, and read through `JUKECORD_DISCORD_TOKEN_FILE` and `JUKECORD_DISCORD_CLIENT_SECRET_FILE`.
  So are the database's address, the metrics token and the logins' secrets. None of them is in the environment yt-dlp
  and ffmpeg start with.

## Memory and CPU

The pod asks for 250m of CPU and 512Mi of memory, and may use up to 1536Mi. Node sets its heap ceiling at about half
the memory limit; the other half holds the rest of Node and the yt-dlp and ffmpeg of each track being fetched, about
70 MB each.

| Memory limit     |     Node's heap ceiling |
| :--------------- | ----------------------: |
| 1536Mi (default) |           about 816 MiB |
| 768Mi            |           about 408 MiB |
| under 512Mi      | about 260 MiB, no lower |

- Below 768Mi that other half is too small for two or more fetches at once: a busy moment takes the pod past its limit,
  and the kernel ends it (`OOMKilled`, with nothing in jukecord's log) before Node notices anything.
- `NODE_OPTIONS` with `--max-old-space-size=<MiB>` in `extraEnv` sets the ceiling yourself, at no more than half the
  limit.
- The fetch limit is half the processors Node sees, between 2 and 6: jukecord fetches at most that many tracks ahead
  at once, and beside them at most twice that many tracks somebody is waiting for (six in all on two processors,
  eighteen on twelve or more). A CPU limit (`resources.limits.cpu`) lowers the processors Node sees, and these numbers
  with them.

## A database server

By default the database is a SQLite file in the volume. `database` points jukecord at a PostgreSQL or MySQL/MariaDB
server instead ([what each needs](INSTALL.md#the-database)): its address as `JUKECORD_DATABASE_URL` takes it, kept in a
Secret, under the key `url`:

```bash
kubectl -n jukecord create secret generic jukecord-database \
  --from-literal=url='postgres://jukecord:choose-a-password@postgres.databases:5432/jukecord'
```

```yaml
database:
  existingSecret: jukecord-database
# The database is in the namespace databases; one in jukecord's own namespace needs no rule (5432 and 3306 there are
# let through by default).
networkPolicy:
  egressTo:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: databases
      ports:
        - port: 5432
```

- `database.url` takes the address in the values instead, and the chart keeps it in a Secret of its own; the release's
  values (`helm get values`) then hold the password too.
- The pod reads the address as a file (`JUKECORD_DATABASE_URL_FILE`), and restarts when it changes.
- The volume still keeps the media cache, the logs and the backups.

To move the SQLite file's data in, stop jukecord, copy the file into the database from a pod of the same image, then
upgrade with the `database` values:

```bash
kubectl -n jukecord scale deploy/jukecord --replicas=0
kubectl -n jukecord wait --for=delete pod -l app.kubernetes.io/instance=jukecord,app.kubernetes.io/component=server
image=$(kubectl -n jukecord get deploy/jukecord -o jsonpath='{.spec.template.spec.containers[0].image}')
kubectl -n jukecord apply -f - <<MANIFEST
apiVersion: v1
kind: Pod
metadata:
  name: jukecord-move
spec:
  restartPolicy: Never
  # Without the namespace's Services as variables: the Service jukecord would set JUKECORD_PORT.
  enableServiceLinks: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: move
      image: $image
      command: [sleep, "1800"]
      env:
        - name: JUKECORD_DATABASE_URL
          valueFrom: { secretKeyRef: { name: jukecord-database, key: url } }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      # SQLite's temporary files go in /tmp.
      volumeMounts: [{ name: data, mountPath: /data }, { name: tmp, mountPath: /tmp }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: jukecord }
    - name: tmp
      emptyDir: {}
MANIFEST
kubectl -n jukecord wait --for=condition=Ready pod/jukecord-move
kubectl -n jukecord exec jukecord-move -- jukecord db copy sqlite:/data/jukecord.db
kubectl -n jukecord delete pod jukecord-move
helm upgrade jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
```

`kubectl -n jukecord exec deploy/jukecord -- jukecord db status` then names the server and the rows it holds.

## Logins through your own accounts

`auth` lets people log in through your identity provider (OIDC) or with directory accounts (LDAP, Active Directory),
as [installing](INSTALL.md#logging-in-through-your-own-accounts) describes; each value is one of the settings there,
and the groups and the scopes are lists. Register jukecord with the provider with the redirect
`<publicUrl>/auth/sso/callback`, and `<publicUrl>/login` after logging out.

```yaml
auth:
  oidc:
    issuer: https://sso.example.com/realms/home
    clientId: jukecord
    existingSecret: jukecord-logins # its key oidcClientSecret
    label: Log in with Home SSO
    adminGroups: [jukecord-admins]
    controlGroups: [jukecord-djs]
    readGroups: ["*"]
  ldap:
    url: ldaps://ldap.example.org
    bindDn: cn=jukecord,ou=services,dc=example,dc=org
    existingSecret: jukecord-logins # its key ldapBindPassword
    baseDn: ou=people,dc=example,dc=org
    adminGroups: [jukecord-admins]
    controlGroups: [jukecord-djs]
    readGroups: ["*"]
  # The authority that signed the directory's certificate (and the provider's, when it is a private one).
  ca:
    configMap: home-ca
    key: ca.crt
  # The directory is on the local network, in a private range.
  egressTo:
    - to:
        - ipBlock:
            cidr: 10.20.0.5/32
      ports:
        - port: 636
```

```bash
kubectl -n jukecord create secret generic jukecord-logins \
  --from-literal=oidcClientSecret="$client_secret" --from-literal=ldapBindPassword="$bind_password"
kubectl -n jukecord create configmap home-ca --from-file=ca.crt=home-ca.pem
```

- `auth.oidc.clientSecret` and `auth.ldap.bindPassword` take the two secrets in the values instead, kept by the chart
  in its Secret `<release>-auth`. Either way jukecord reads them as files.
- `auth.ca` is a Secret or a ConfigMap of yours (`secret` or `configMap`), its `key` holding the certificates in PEM.
  The directory's connection checks against it (`JUKECORD_LDAP_CA_FILE`), and so do the requests to the provider
  (`NODE_EXTRA_CA_CERTS`, beside the public authorities).
- A provider or a directory on the internet needs no rule; one in the cluster's private ranges needs its rule in
  `auth.egressTo`.
- Only the pods that log people in get these settings: the one pod, or the edges in split mode, where
  `kubectl -n jukecord exec deploy/jukecord-edge -- jukecord auth test-oidc` (and `test-ldap <name>`) checks them.

## Monitoring

jukecord answers `/metrics` to a Prometheus in the cluster that reads it from the Service, with nothing to set
([what it reports](API.md#metrics)). With the Prometheus Operator, the chart makes the ServiceMonitor:

```yaml
metrics:
  serviceMonitor:
    enabled: true
    # The labels your Prometheus picks ServiceMonitors by (kube-prometheus-stack: release: <its release>).
    labels:
      release: kube-prometheus-stack
networkPolicy:
  ingressFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
    # The Prometheus that scrapes it, when ingressFrom names who may reach the port.
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app.kubernetes.io/name: prometheus
```

- The ServiceMonitor is made when the cluster has its CRD (`monitoring.coreos.com/v1`); `metrics.serviceMonitor.force`
  makes it anyway, for `helm template` and tools that render charts without a cluster (Argo CD, Flux).
- A Prometheus that finds its targets by annotation takes `metrics.podAnnotations: true` (`prometheus.io/scrape`,
  `/port` and `/path` on the pod).
- From outside the cluster, through a proxy or through a service mesh's sidecar (which adds forwarding headers),
  jukecord answers only a scraper that shows the metrics token: `metrics.token`, or `metrics.existingSecret` with the
  key `metricsToken`. The ServiceMonitor then sends it.
- `/readyz` answers by parts, and the readiness probe follows it, so a pod whose database or bus does not answer is
  taken out of its Service. `deploy/monitoring/alerts.yaml` holds the alert rules (a PrometheusRule's `groups`), and
  `deploy/monitoring/grafana-dashboard.json` the Grafana dashboard ([monitoring](INSTALL.md#monitoring)).

## Split into services

`mode: split` runs one core (Discord, every server's player and queue, the media and its cache: one pod, replaced with
`Recreate`, with the volume) and edges (the panel, the API, the live updates and the logins: as many pods as you like,
with no volume), from the same image ([what each does](INSTALL.md#split-into-services)). They need a database server
and a Redis or Valkey server, each address in a Secret of yours under the key `url` (or `database.url` and `bus.url`
in the values):

```bash
kubectl -n jukecord create secret generic jukecord-database \
  --from-literal=url='postgres://jukecord:choose-a-password@postgres:5432/jukecord'
kubectl -n jukecord create secret generic jukecord-bus --from-literal=url='redis://valkey:6379'
```

```yaml
mode: split
database:
  existingSecret: jukecord-database
bus:
  existingSecret: jukecord-bus
split:
  edge:
    replicas: 3
discord:
  existingSecret: jukecord-discord
  clientId: "YOUR_APPLICATION_ID"
publicUrl: https://music.example.com
ingress:
  enabled: true
  host: music.example.com
  tls:
    - secretName: jukecord-tls
      hosts: [music.example.com]
```

- The Service (`jukecord`) and the Ingress reach the edges. The core has a Service of its own (`jukecord-core`): its
  internal port, which only the edges may reach (the NetworkPolicy and the internal secret both say so), and its own
  port with `/healthz`, `/readyz` and `/metrics`.
- `split.existingSecret` takes the internal secret from a Secret of yours (key `internalSecret`, 32 characters or
  more); without it the chart makes one at the install and keeps it on every upgrade.
- `split.edge.autoscaling.enabled` puts a HorizontalPodAutoscaler on the edges (2 to 6, at 70 % of their processor
  requests, by default). `split.core.resources` and `split.edge.resources` set each part's requests and limits.
- A database and a bus in jukecord's namespace are let through by default (5432, 3306 and 6379); elsewhere they need
  their rules in `networkPolicy.egressTo`.
- The `jukecord` command runs in an edge, which asks the core: `kubectl -n jukecord exec deploy/jukecord-edge --
  jukecord link`. The ServiceMonitor scrapes the core and every edge.
- A one-pod release moves to split mode with its data: [move the SQLite file](#a-database-server) into the database
  first, then upgrade with `mode: split` and the bus.

## Upgrading

```bash
kubectl -n jukecord exec deploy/jukecord -- jukecord backup
helm upgrade jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
```

- The backup stays in the volume until [backup and restore](#backup-and-restore) copies it out.
- Without `--version` Helm takes the newest chart, and with it the newest jukecord; `--version X.Y.Z` picks one.
- With your values file given again, the newer chart's defaults apply wherever your file says nothing.
  `--reuse-values` in its place keeps the release's values as they were, the older chart's defaults among them, and
  gives what the newer chart adds its default (Helm 3.14 and newer have `--reset-then-reuse-values` to take the newer
  defaults as well).
- From 0.3, either is all it takes: the groups 0.4 adds (`database`, `auth`, `metrics`, `mode`, `bus`, `split`) take
  their defaults, so jukecord runs as before, one pod on the SQLite file in the volume.
- The new jukecord moves the database to its schema by itself on its first start.
- `helm rollback` brings back the older chart and jukecord, but after an upgrade that moved the database to a newer
  schema, the older jukecord refuses to start ("the database is at schema N, newer than this jukecord knows"). Restore
  the backup taken before the upgrade, then roll back.

## Uninstalling

```bash
helm uninstall jukecord -n jukecord
```

The chart keeps the data volume's claim, so an uninstall by mistake does not take a server's history with it;
installing again under the same name in the same namespace takes it back. To remove the data as well:

```bash
kubectl -n jukecord delete pvc jukecord
```

A claim of your own, given as `persistence.existingClaim`, is never made or removed by the chart: the data lives as
long as you keep that claim, and another install can be pointed at it.

## Backup and restore

`jukecord backup` writes a consistent copy of the database into the volume while jukecord runs, and `kubectl cp`
takes it out. The media cache is not in it: tracks are fetched again when played. `env: { JUKECORD_BACKUP_AT:
"04:30" }` makes one every day at that time in the pod's time zone (`TZ` in `extraEnv`, else UTC), and the volume
keeps the newest `JUKECORD_BACKUP_KEEP` (7).

```bash
pod=$(kubectl -n jukecord get pod -l app.kubernetes.io/instance=jukecord,app.kubernetes.io/component=server \
  -o jsonpath='{.items[0].metadata.name}')
out=$(kubectl -n jukecord exec "$pod" -- jukecord backup) && file=${out%% (*} &&
  kubectl -n jukecord cp "$pod:$file" "./${file##*/}"
```

`jukecord backup` prints the copy's path and size (`/data/backups/jukecord-<time>.db (412 KiB)`); when it cannot make
one, it says why and nothing is copied. In split mode it runs in an edge and writes into the core's volume:
`component=core` in the line above finds the pod to copy it from, and `exec deploy/jukecord-edge` makes it.

To put a copy back, stop jukecord, start a pod of the same image on the volume, swap the database there, and start
jukecord again. The claim is named after the release (`jukecord`), or is your `existingClaim`. The database it
replaces stays in the volume as `jukecord.db.before-restore`, with its `-wal` and `-shm` files when there are any.
The first line names the copy to put back:

```bash
backup=./jukecord-TIME.db
kubectl -n jukecord scale deploy/jukecord --replicas=0
kubectl -n jukecord wait --for=delete pod -l app.kubernetes.io/instance=jukecord,app.kubernetes.io/component=server
image=$(kubectl -n jukecord get deploy/jukecord -o jsonpath='{.spec.template.spec.containers[0].image}')
kubectl -n jukecord apply -f - <<MANIFEST
apiVersion: v1
kind: Pod
metadata:
  name: jukecord-restore
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: restore
      image: $image
      command: [sleep, "1800"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: jukecord }
MANIFEST
kubectl -n jukecord wait --for=condition=Ready pod/jukecord-restore
kubectl -n jukecord cp "$backup" jukecord-restore:/data/jukecord.db.restoring
kubectl -n jukecord exec jukecord-restore -- sh -c 'cd /data &&
  for part in jukecord.db jukecord.db-wal jukecord.db-shm; do
    if [ -f "$part" ]; then mv "$part" "$part.before-restore"; fi
  done &&
  mv jukecord.db.restoring jukecord.db'
kubectl -n jukecord delete pod jukecord-restore
kubectl -n jukecord scale deploy/jukecord --replicas=1
```

### On a database server

The backup of a database server is a SQLite file of the whole database too. It goes back the same way, from a pod
given the database's address (here from the Secret `jukecord-database` of [a database server](#a-database-server); the
chart's own is named the same when the address is in the values). What the database holds is saved in the volume
first, then the backup is copied into it in one transaction:

```bash
backup=./jukecord-TIME.db
kubectl -n jukecord scale deploy/jukecord --replicas=0
kubectl -n jukecord wait --for=delete pod -l app.kubernetes.io/instance=jukecord,app.kubernetes.io/component=server
image=$(kubectl -n jukecord get deploy/jukecord -o jsonpath='{.spec.template.spec.containers[0].image}')
kubectl -n jukecord apply -f - <<MANIFEST
apiVersion: v1
kind: Pod
metadata:
  name: jukecord-restore
spec:
  restartPolicy: Never
  # Without the namespace's Services as variables: the Service jukecord would set JUKECORD_PORT.
  enableServiceLinks: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: restore
      image: $image
      command: [sleep, "1800"]
      env:
        - name: JUKECORD_DATABASE_URL
          valueFrom: { secretKeyRef: { name: jukecord-database, key: url } }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      # SQLite's temporary files go in /tmp.
      volumeMounts: [{ name: data, mountPath: /data }, { name: tmp, mountPath: /tmp }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: jukecord }
    - name: tmp
      emptyDir: {}
MANIFEST
kubectl -n jukecord wait --for=condition=Ready pod/jukecord-restore
kubectl -n jukecord cp "$backup" jukecord-restore:/data/restore.db
kubectl -n jukecord exec jukecord-restore -- \
  jukecord db copy configured "sqlite:/data/jukecord-before-restore-$(date -u +%Y%m%dT%H%M%SZ).db"
kubectl -n jukecord exec jukecord-restore -- jukecord db copy sqlite:/data/restore.db --replace
kubectl -n jukecord exec jukecord-restore -- rm /data/restore.db
kubectl -n jukecord delete pod jukecord-restore
kubectl -n jukecord scale deploy/jukecord --replicas=1
```

In split mode the claim is the core's, named after the release as well: scale `deploy/jukecord-core` and
`deploy/jukecord-edge` to 0, wait for the pods of `app.kubernetes.io/component in (core,edge)`, take the image from
`deploy/jukecord-core`, and afterwards scale the core to 1 and the edges to their replicas.

## Restarts, drains and upgrades

A drain, an upgrade or a restart stops the music while the old pod stops and the new one starts: seconds on the same
node, longer when the volume has to move to another node. jukecord leaves voice within 10 seconds of being told to
stop, and on its next start every server is back where it was, paused, with its queue and history. The chart makes no
PodDisruptionBudget: with one replica, one that kept the pod would hold up every drain, and one that let it go would
change nothing. In split mode the same goes for the core; an edge drained or restarted leaves the others serving the
panels.

## k3s and Raspberry Pi clusters

The image runs on arm64, so the chart works on k3s on Raspberry Pi 5 nodes as it is. k3s's default storage class
(local-path) suits the data volume. Its default network (flannel) applies NetworkPolicies only with k3s's network
policy controller, which current k3s turns on by default.

## Testing the chart

`deploy/kind/check.sh` takes an image built from your checkout and builds nothing itself. On a throwaway kind cluster
it installs the chart, runs `helm test`, and checks the jukecord command and the API, that the data survives a new
pod, that the NetworkPolicy keeps the pod away from another pod's port while it still reaches the internet (it fetches
example.com), and that an uninstall keeps the volume for a reinstall. Then it deletes the cluster.
`deploy/kind/check-split.sh` does the same for split mode, with a PostgreSQL and a Valkey beside it and the logins set
up: an edge reaches the core's internal port and another pod does not, and the edges are ready again once the core's
pod is replaced.

```bash
docker build -f deploy/docker/Dockerfile -t jukecord:dev .
deploy/kind/check.sh jukecord:dev
deploy/kind/check-split.sh jukecord:dev
```
