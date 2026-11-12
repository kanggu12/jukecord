# jukecord on Kubernetes

For people who run jukecord on a cluster: installing the Helm chart, its values, the Ingress and the NetworkPolicy,
security, memory, upgrades, backups and k3s.

The chart runs one pod, a Service, a volume for the database and the cache, and optionally an Ingress. It never runs a
second replica: a bot token allows one Discord session. It is published as an OCI chart.

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

| Value                                                             |                       Default                       | Sets                                                           |
| :---------------------------------------------------------------- | :-------------------------------------------------: | :------------------------------------------------------------- |
| `image.repository`, `image.tag`                                   | `ghcr.io/kanggu12/jukecord`, the chart's appVersion | the image: another registry's copy, or your own build          |
| `imagePullSecrets`                                                |                        `[]`                         | Secrets to pull the image with (helm test's pod uses them too) |
| `discord.existingSecret`                                          |                                                     | a Secret with `token` and `clientSecret`                       |
| `discord.token`, `discord.clientSecret`                           |                                                     | the same in the values; the chart makes the Secret             |
| `discord.clientId`                                                |                                                     | the application's ID (`--set-string`: it is a long number)     |
| `publicUrl`                                                       |                 the Ingress's host                  | the panel's address, for logins and the bot's links            |
| `env`                                                             |                        `{}`                         | any [setting](README.md#settings) by name, as a string         |
| `extraEnv`                                                        |                        `[]`                         | more variables as Kubernetes writes them                       |
| `ingress.enabled`, `.host`, `.className`, `.annotations`, `.tls`  |                         off                         | [the Ingress](#the-ingress)                                    |
| `persistence.enabled`, `.size`, `.storageClass`, `.existingClaim` |                      on, `5Gi`                      | the data volume, kept when the release is uninstalled          |
| `networkPolicy.enabled`, `.ingressFrom`, `.privateRanges`         |                         on                          | [the NetworkPolicy](#the-networkpolicy)                        |
| `resources`                                                       |              250m, 512Mi; limit 1536Mi              | requests and limits ([memory and CPU](#memory-and-cpu))        |
| `service.type`, `.port`                                           |                 `ClusterIP`, `8795`                 | the Service                                                    |
| `podLabels`, `podAnnotations`                                     |                        `{}`                         | more for the pod; the chart's own labels win                   |
| `podSecurityContext`, `securityContext`                           |       user 10001, read-only, no capabilities        | [security](#security)                                          |
| `nodeSelector`, `tolerations`, `affinity`                         |                                                     | where the pod may run; helm test's pod follows the first two   |

- The pod does not start without the Secret's `token`; its `clientSecret` is read when a client ID is set.
- `publicUrl` defaults to the Ingress's host, with https when the Ingress has TLS.
- `env` takes values such as `JUKECORD_CACHE_MAX: 8GiB`; quote numbers and IDs. The chart sets the port, the
  listening address, the data directory and the two `*_FILE` secrets, and the token and the OAuth secret go in
  `discord`: the schema refuses all of these in `env` and in `extraEnv`.
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
- The Ingress sends every path to jukecord, `/metrics` too, which answers without a login and tells anyone how many
  people listen. It is meant for a Prometheus inside the cluster, reading it from the Service (port 8795). Where your
  controller can leave a path out, leave `/metrics` out of what the Ingress publishes.

## The NetworkPolicy

In: the panel's port only. Out: DNS, and the internet on any port (Discord's voice servers use UDP on ports they
choose), but none of the private ranges in `networkPolicy.privateRanges`, so jukecord cannot reach other services in
the cluster.

- If your cluster's pods or services use other ranges, list them.
- For jukecord to reach something private (a proxy to the internet, say), turn the policy off or add your own.
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
  They are not in the environment yt-dlp and ffmpeg start with.

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

## Upgrading

```bash
kubectl -n jukecord exec deploy/jukecord -- jukecord backup
helm upgrade jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
```

- The backup stays in the volume until [backup and restore](#backup-and-restore) copies it out.
- Without `--version` Helm takes the newest chart, and with it the newest jukecord; `--version X.Y.Z` picks one.
- Give your values file again: `--reuse-values` also keeps the old chart's defaults, so what a newer chart adds or
  changes in them would not apply (Helm 3.14 and newer have `--reset-then-reuse-values` for that).
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
file=$(kubectl -n jukecord exec "$pod" -- jukecord backup --json | sed -n 's/.*"file": *"\([^"]*\)".*/\1/p')
kubectl -n jukecord cp "$pod:$file" "./${file##*/}"
```

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

## Restarts, drains and upgrades

A drain, an upgrade or a restart stops the music while the old pod stops and the new one starts: seconds on the same
node, longer when the volume has to move to another node. jukecord leaves voice within 10 seconds of being told to
stop, and on its next start every server is back where it was, paused, with its queue and history. The chart makes no
PodDisruptionBudget: with one replica, one that kept the pod would hold up every drain, and one that let it go would
change nothing.

## k3s and Raspberry Pi clusters

The image runs on arm64, so the chart works on k3s on Raspberry Pi 5 nodes as it is. k3s's default storage class
(local-path) suits the data volume. Its default network (flannel) applies NetworkPolicies only with k3s's network
policy controller, which current k3s turns on by default.

## Testing the chart

`deploy/kind/check.sh` takes an image built from your checkout and builds nothing itself. On a throwaway kind cluster
it installs the chart, runs `helm test`, and checks the jukecord command and the API, that the data survives a new
pod, that the NetworkPolicy keeps the pod away from another pod's port while it still reaches the internet (it fetches
example.com), and that an uninstall keeps the volume for a reinstall. Then it deletes the cluster.

```bash
docker build -f deploy/docker/Dockerfile -t jukecord:dev .
deploy/kind/check.sh jukecord:dev
```
