# jukecord on Kubernetes

The Helm chart runs one pod (a bot token allows one Discord session, so there is never a second replica), a Service, a
volume for the database and the cache, and optionally an Ingress. It is published as an OCI chart.

```bash
kubectl create namespace jukecord
kubectl -n jukecord create secret generic jukecord-discord \
  --from-literal=token=YOUR_BOT_TOKEN --from-literal=clientSecret=YOUR_OAUTH_SECRET
helm install jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord \
  --set discord.existingSecret=jukecord-discord \
  --set-string discord.clientId=YOUR_APPLICATION_ID \
  --set ingress.enabled=true --set ingress.host=music.example.com \
  --set publicUrl=https://music.example.com
kubectl -n jukecord exec deploy/jukecord -- jukecord link
```

The last line prints a one-time login link for the host. `kubectl -n jukecord exec deploy/jukecord -- jukecord doctor`
checks every part jukecord needs.

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
| `networkPolicy.enabled`, `.privateRanges`                         | on                                                  | see below                                                                                                                                                                                                                                                                                                      |
| `resources`                                                       | 250m, 512Mi; limit 1536Mi                           | requests and limits ([below](#memory-and-cpu))                                                                                                                                                                                                                                                                 |
| `service.type`, `.port`                                           | `ClusterIP`, `8795`                                 | the Service                                                                                                                                                                                                                                                                                                    |

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

With the Ingress on, jukecord believes one proxy's `X-Forwarded-For` (for the login limiter), unless `env` sets
`JUKECORD_TRUST_PROXY` otherwise.

## The NetworkPolicy

In: the panel's port only. Out: DNS, and the internet on any port (Discord's voice servers use UDP on ports they
choose), but none of the private ranges in `networkPolicy.privateRanges`: jukecord cannot reach other services in the
cluster. If your cluster's pods or services use other ranges, list them; if jukecord should reach something private (a
proxy for the internet, say), turn the policy off or add your own. Fetching tracks from a private address also needs
`JUKECORD_ALLOW_PRIVATE_ADDRESSES: "true"` in `env`, since jukecord refuses those addresses on its own as well.

## Security

The pod runs as user 10001 with a read-only root filesystem, no capabilities, no privilege escalation, the default
seccomp profile, no Kubernetes API token and no Service environment variables. The image writes only to `/data` and
`/tmp`. The bot's token and the OAuth secret are mounted from the Secret as files in `/run/secrets/jukecord`, readable
by jukecord's group only, and jukecord reads them through `JUKECORD_DISCORD_TOKEN_FILE` and
`JUKECORD_DISCORD_CLIENT_SECRET_FILE`: they are not in the environment that yt-dlp and ffmpeg start with.

## Memory and CPU

The pod asks for 250m of CPU and 512Mi of memory, and may use up to 1536Mi. Node sets the ceiling of its heap at
about half of the container's memory limit (816 MiB at 1536Mi, 408 MiB at 768Mi), and yt-dlp and ffmpeg run beside it
within the same limit: about 70 MB each for every track being fetched. jukecord fetches ahead as many tracks at once as
half the processors Node sees, between 2 and 6, so a large node fetches more at a time; a CPU limit
(`resources.limits.cpu`) lowers how many processors Node sees, and with them that number.

Keep the memory limit at 768Mi or more. Node lets its heap grow to about half the limit; the other half holds the
rest of Node and the yt-dlp and ffmpeg of the tracks being fetched, at least two at once. Below 768Mi that half is too
small for both, so a busy moment takes the pod past its limit, and the kernel ends it (`OOMKilled`, with nothing in
jukecord's log) before Node notices anything. Under 512Mi it gets worse: the heap ceiling stops shrinking with the
limit (Node keeps about 260 MiB). To set the ceiling yourself, give `NODE_OPTIONS` with `--max-old-space-size=<MiB>`
in `extraEnv`, at no more than half the limit.

## k3s and Raspberry Pi clusters

The image runs on arm64, so the chart works on k3s on Raspberry Pi 5 nodes as it is. k3s's default storage class
(local-path) suits the data volume; its default network (flannel) does not apply NetworkPolicies unless k3s's network
policy controller is on (it is by default in current k3s).

## Testing the chart

`deploy/kind/check.sh` builds nothing itself: give it an image built from your checkout, and it installs the chart on a
throwaway kind cluster, runs `helm test`, checks the jukecord command and the API, that the data survives a new pod, and
that the NetworkPolicy keeps the pod away from another pod's port, then deletes the cluster.

```bash
docker build -f deploy/docker/Dockerfile -t jukecord:dev .
deploy/kind/check.sh jukecord:dev
```
