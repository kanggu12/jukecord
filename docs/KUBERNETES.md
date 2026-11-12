# jukecord on Kubernetes

The Helm chart runs one pod (a bot token allows one Discord session, so there is never a second replica), a Service, a
volume for the database and the cache, and optionally an Ingress. It is published as an OCI chart.

The values go in a file of your own, `jukecord-values.yaml`, which every later `helm upgrade` is given again:

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

```bash
kubectl create namespace jukecord
kubectl -n jukecord create secret generic jukecord-discord \
  --from-literal=token=YOUR_BOT_TOKEN --from-literal=clientSecret=YOUR_OAUTH_SECRET
helm install jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
kubectl -n jukecord exec deploy/jukecord -- jukecord link
```

The last line prints a one-time login link for the host. `kubectl -n jukecord exec deploy/jukecord -- jukecord doctor`
checks every part jukecord needs. Without TLS on the Ingress (or in front of its controller), logins cross the network
unencrypted; the notes Helm prints after the install say so.

jukecord reads the token and the OAuth secret when it starts. A new token put in the Secret takes effect when the pod
starts again: `kubectl -n jukecord rollout restart deploy/jukecord`. (With the token in the values instead, a
`helm upgrade` with the new one restarts the pod by itself.)

## Values

| Value                                                             | Default                                             | Sets                                                                                                                                                                                                                                                                                                           |
| :---------------------------------------------------------------- | :-------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`, `image.tag`                                   | `ghcr.io/kanggu12/jukecord`, the chart's appVersion | the image (another registry's copy, or a build of yours)                                                                                                                                                                                                                                                       |
| `discord.existingSecret`                                          |                                                     | a Secret with `token` (the pod does not start without it) and `clientSecret` (read when a client ID is set)                                                                                                                                                                                                    |
| `discord.token`, `discord.clientSecret`                           |                                                     | the same in the values (the chart makes the Secret)                                                                                                                                                                                                                                                            |
| `discord.clientId`                                                |                                                     | the application's ID (use `--set-string`: it is a long number)                                                                                                                                                                                                                                                 |
| `publicUrl`                                                       |                                                     | the panel's address, for login and the bot's links; without it, the Ingress's host (https when the Ingress has TLS)                                                                                                                                                                                            |
| `env`                                                             | `{}`                                                | any [setting](README.md#settings) by name, as a string (`JUKECORD_CACHE_MAX: 8GiB`, `JUKECORD_DISCORD_CLIENT_ID: "123…"`); the port, the listening address, the data directory and the two `*_FILE` secrets are the chart's, and the token and the OAuth secret go in `discord` (the schema refuses them here) |
| `extraEnv`                                                        | `[]`                                                | more variables as Kubernetes writes them (`name` with `value`, or `valueFrom` a ConfigMap): `NODE_OPTIONS`, `TZ`, `HTTPS_PROXY`; the names refused in `env` are refused here too                                                                                                                               |
| `ingress.enabled`, `.host`, `.className`, `.annotations`, `.tls`  | off                                                 | the panel from outside the cluster                                                                                                                                                                                                                                                                             |
| `persistence.enabled`, `.size`, `.storageClass`, `.existingClaim` | on, `5Gi`                                           | the data volume (kept when the release is uninstalled)                                                                                                                                                                                                                                                         |
| `networkPolicy.enabled`, `.ingressFrom`, `.privateRanges`         | on, anyone may reach the port                       | [below](#the-networkpolicy)                                                                                                                                                                                                                                                                                    |
| `resources`                                                       | 250m, 512Mi; limit 1536Mi                           | requests and limits ([below](#memory-and-cpu))                                                                                                                                                                                                                                                                 |
| `service.type`, `.port`                                           | `ClusterIP`, `8795`                                 | the Service                                                                                                                                                                                                                                                                                                    |
| `podLabels`, `podAnnotations`                                     | `{}`                                                | more labels and annotations for the pod (the chart's own labels win)                                                                                                                                                                                                                                           |
| `podSecurityContext`, `securityContext`                           | user 10001, read-only, no capabilities              | the pod's and the container's security settings ([Security](#security))                                                                                                                                                                                                                                        |
| `nodeSelector`, `tolerations`, `affinity`                         |                                                     | where the pod may run (helm test's pod follows the first two)                                                                                                                                                                                                                                                  |

Every value is checked against the chart's `values.schema.json`, so a misspelt key fails the install.

## The Ingress

WebSocket (`/api/v1/events`) passes through ingress-nginx, Traefik and most others as it is. Give it a long read
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

With the Ingress on, jukecord believes one proxy's `X-Forwarded-For` (for the login limiter), unless `env` or
`extraEnv` sets `JUKECORD_TRUST_PROXY` otherwise. A pod that reaches jukecord's port directly, not through the controller, could then
put any address in that header; `networkPolicy.ingressFrom` (below) lets in the controller alone.

The Ingress sends every path to jukecord, `/metrics` too, which answers without a login and tells anyone how many
people listen. It is meant for a Prometheus inside the cluster, which reads it from the Service (port 8795), not for
the internet: where your controller can leave a path out, leave `/metrics` out of what the Ingress publishes.

## The NetworkPolicy

In: the panel's port only. Out: DNS, and the internet on any port (Discord's voice servers use UDP on ports they
choose), but none of the private ranges in `networkPolicy.privateRanges`: jukecord cannot reach other services in the
cluster. If your cluster's pods or services use other ranges, list them; if jukecord should reach something private (a
proxy for the internet, say), turn the policy off or add your own. Fetching tracks from a private address also needs
`JUKECORD_ALLOW_PRIVATE_ADDRESSES: "true"` in `env`, since jukecord refuses those addresses on its own as well.

Anyone in the cluster may reach the panel's port unless `networkPolicy.ingressFrom` names who may, as NetworkPolicy
peers. Behind an Ingress, name its controller, so that the `X-Forwarded-For` jukecord believes can only come from it;
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

The pod runs as user 10001 with a read-only root filesystem, no capabilities, no privilege escalation, the default
seccomp profile, no Kubernetes API token and no Service environment variables. The image writes only to `/data` and
`/tmp`. The bot's token and the OAuth secret are mounted from the Secret as files in `/run/secrets/jukecord`, readable
by jukecord's group only, and jukecord reads them through `JUKECORD_DISCORD_TOKEN_FILE` and
`JUKECORD_DISCORD_CLIENT_SECRET_FILE`: they are not in the environment that yt-dlp and ffmpeg start with.

## Memory and CPU

The pod asks for 250m of CPU and 512Mi of memory, and may use up to 1536Mi. Node sets the ceiling of its heap at
about half of the container's memory limit (816 MiB at 1536Mi, 408 MiB at 768Mi), and yt-dlp and ffmpeg run beside it
within the same limit: about 70 MB each for every track being fetched. The fetch limit is half the processors Node
sees, between 2 and 6: jukecord fetches at most that many tracks ahead of time at once, and beside them at most twice
that many tracks somebody is waiting for (in all, six on two processors and eighteen on twelve or more). A CPU limit
(`resources.limits.cpu`) lowers how many processors Node sees, and with them those numbers.

Keep the memory limit at 768Mi or more. Node lets its heap grow to about half the limit; the other half holds the
rest of Node and the yt-dlp and ffmpeg of the tracks being fetched, two or more at once. Below 768Mi that half is too
small for both, so a busy moment takes the pod past its limit, and the kernel ends it (`OOMKilled`, with nothing in
jukecord's log) before Node notices anything. Under 512Mi it gets worse: the heap ceiling stops shrinking with the
limit (Node keeps about 260 MiB). To set the ceiling yourself, give `NODE_OPTIONS` with `--max-old-space-size=<MiB>`
in `extraEnv`, at no more than half the limit.

## Upgrading

```bash
kubectl -n jukecord exec deploy/jukecord -- jukecord backup
helm upgrade jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
```

Take a backup first; it stays in the volume until [Backup and restore](#backup-and-restore) copies it out. Without
`--version` Helm takes the newest chart, and with it the newest jukecord; `--version X.Y.Z` picks one. Give your
values file again rather than `--reuse-values`, which also keeps the old chart's defaults, so what a newer chart adds
or changes in them would not apply (Helm 3.14 and newer have `--reset-then-reuse-values` for that). The old pod stops
before the new one starts, and on its first start the new jukecord moves the database to its schema by itself.

`helm rollback` brings back the older chart and the older jukecord, but after an upgrade that moved the database to a
newer schema, the older jukecord refuses to start on it ("the database is at schema N, newer than this jukecord
knows"). To go back then, restore the backup taken before the upgrade (below), and roll back after that.

## Uninstalling

```bash
helm uninstall jukecord -n jukecord
```

The data volume stays: the chart keeps its claim on purpose, so an uninstall by mistake does not take a server's
history with it. Installing again under the same name in the same namespace takes it back. To remove the data as well:

```bash
kubectl -n jukecord delete pvc jukecord
```

A claim of your own, given as `persistence.existingClaim`, is never made or removed by the chart: the data lives as
long as you keep that claim, whatever happens to the release, and another install can be pointed at it.

## Backup and restore

`jukecord backup` writes a consistent copy of the database into the volume while jukecord runs, and `kubectl cp` takes
it out. The media cache is not in it (tracks are fetched again when they are played).

```bash
pod=$(kubectl -n jukecord get pod -l app.kubernetes.io/instance=jukecord,app.kubernetes.io/component=server \
  -o jsonpath='{.items[0].metadata.name}')
file=$(kubectl -n jukecord exec "$pod" -- jukecord backup --json | sed -n 's/.*"file": *"\([^"]*\)".*/\1/p')
kubectl -n jukecord cp "$pod:$file" "./${file##*/}"
```

To put a copy back, stop jukecord, start a pod of the same image on the volume, swap the database there, and start
jukecord again. The database it replaces stays in the volume as `jukecord.db.before-restore` (with its `-wal` and
`-shm` files, when there are any). The claim is named after the release (`jukecord`), or is your `existingClaim`:

```bash
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
kubectl -n jukecord cp ./jukecord-TIME.db jukecord-restore:/data/jukecord.db.restoring
kubectl -n jukecord exec jukecord-restore -- sh -c 'cd /data &&
  for part in jukecord.db jukecord.db-wal jukecord.db-shm; do
    if [ -f "$part" ]; then mv "$part" "$part.before-restore"; fi
  done &&
  mv jukecord.db.restoring jukecord.db'
kubectl -n jukecord delete pod jukecord-restore
kubectl -n jukecord scale deploy/jukecord --replicas=1
```

## Restarts, drains and upgrades

jukecord runs as one pod, and the chart makes no PodDisruptionBudget: with one replica, a budget that kept the pod
would hold up every node drain, and one that let it go would change nothing. A drain, an upgrade or a restart
therefore stops the music for as long as the old pod takes to stop and the new one to start: seconds on the same node,
longer when the volume has to move to another node. jukecord leaves the voice channels within 10 seconds of being told
to stop, and on its next start every server's track is back where it was, paused, with the queue and the history:
someone presses play. Drain the node it runs on at a quiet moment.

## k3s and Raspberry Pi clusters

The image runs on arm64, so the chart works on k3s on Raspberry Pi 5 nodes as it is. k3s's default storage class
(local-path) suits the data volume; its default network (flannel) does not apply NetworkPolicies unless k3s's network
policy controller is on (it is by default in current k3s).

## Testing the chart

`deploy/kind/check.sh` builds nothing itself: give it an image built from your checkout, and it installs the chart on a
throwaway kind cluster, runs `helm test`, checks the jukecord command and the API, that the data survives a new pod,
that the NetworkPolicy keeps the pod away from another pod's port while it still reaches the internet (it fetches
example.com), and that an uninstall keeps the volume for a reinstall, then deletes the cluster.

```bash
docker build -f deploy/docker/Dockerfile -t jukecord:dev .
deploy/kind/check.sh jukecord:dev
```
