# jukecord Helm chart

[jukecord](https://github.com/kanggu12/jukecord) is a self-hosted Discord music bot whose queue you also hear in the
browser: one queue per Discord server, played in its voice channel and, for anyone who presses **Listen here**, in
their browser at the same place in the track. This chart runs it on Kubernetes, on amd64 and arm64 nodes (k3s and
Raspberry Pi clusters included).

## What it deploys

| Object        | What for                                                                                                                          |
| :------------ | :-------------------------------------------------------------------------------------------------------------------------------- |
| Deployment    | one pod (a bot token allows one Discord session), replaced with `Recreate` so two never run at once                               |
| Service       | the panel, the HTTP API and the live updates, on port 8795                                                                        |
| PVC           | the database, the media cache and the logs; kept when the release is uninstalled                                                  |
| Secret        | the bot's token and the OAuth secret, when they are given in the values (not with `discord.existingSecret`)                       |
| Ingress       | the panel from outside the cluster, when `ingress.enabled`                                                                        |
| NetworkPolicy | in: the panel's port (from the peers in `ingressFrom`, when set); out: DNS and the internet, none of the cluster's private ranges |
| Test pod      | `helm test`: the panel answers through the Service                                                                                |

The pod runs as user 10001 with a read-only root filesystem, no capabilities and no Kubernetes API token. The bot's
token and the OAuth secret reach jukecord as mounted files, not as environment variables.

## Install

The values go in a file of your own, which every later `helm upgrade` is given again:

```yaml
# jukecord-values.yaml
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

```bash
kubectl create namespace jukecord
kubectl -n jukecord create secret generic jukecord-discord \
  --from-literal=token=YOUR_BOT_TOKEN --from-literal=clientSecret=YOUR_OAUTH_SECRET
helm install jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
kubectl -n jukecord exec deploy/jukecord -- jukecord link
```

The last line prints a one-time login link for the host. Without a bot token jukecord plays in the browser only.
`kubectl -n jukecord exec deploy/jukecord -- jukecord doctor` checks every part it needs.

## Values

| Value                                                                                        | Default                                             | Sets                                                                                                                       |
| :------------------------------------------------------------------------------------------- | :-------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`, `image.tag`                                                              | `ghcr.io/kanggu12/jukecord`, the chart's appVersion | the image (another registry's copy, or a build of yours)                                                                   |
| `discord.existingSecret`                                                                     |                                                     | a Secret with `token` (the pod does not start without it) and `clientSecret` (read when a client ID is set)                |
| `discord.token`, `discord.clientSecret`                                                      |                                                     | the same in the values (the chart makes the Secret); refused together with `existingSecret`                                |
| `discord.clientId`                                                                           |                                                     | the application's ID, for logging in with Discord (a string: it is a long number)                                          |
| `publicUrl`                                                                                  |                                                     | the panel's address, for logins and the bot's links                                                                        |
| `env`                                                                                        | `{}`                                                | jukecord's settings by name, as strings (`JUKECORD_CACHE_MAX: 8GiB`); the secrets and the names the chart sets are refused |
| `extraEnv`                                                                                   | `[]`                                                | more variables as Kubernetes writes them (`NODE_OPTIONS`, `TZ`, a value from a ConfigMap)                                  |
| `ingress.enabled`, `.host`, `.className`, `.annotations`, `.tls`                             | off                                                 | the panel from outside the cluster                                                                                         |
| `persistence.enabled`, `.size`, `.storageClass`, `.existingClaim`                            | on, `5Gi`                                           | the data volume                                                                                                            |
| `networkPolicy.enabled`, `.ingressFrom`, `.privateRanges`                                    | on, anyone, the private ranges                      | the NetworkPolicy: who may reach the panel's port, and the ranges jukecord is kept away from                               |
| `resources`                                                                                  | 250m, 512Mi; limit 1536Mi                           | requests and limits (Node's heap ceiling is about half the memory limit)                                                   |
| `service.type`, `.port`                                                                      | `ClusterIP`, `8795`                                 | the Service                                                                                                                |
| `podLabels`, `podAnnotations`, `nodeSelector`, `tolerations`, `affinity`, `imagePullSecrets` |                                                     | the usual pod settings; helm test's pod follows the pull secrets, node selector and tolerations                            |

Every value is checked against the chart's schema, so a misspelt key fails the install. The settings jukecord reads
are listed in [Using jukecord](https://github.com/kanggu12/jukecord/blob/main/docs/README.md#settings).

## Upgrade and uninstall

```bash
kubectl -n jukecord exec deploy/jukecord -- jukecord backup
helm upgrade jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
helm uninstall jukecord -n jukecord
```

An upgrade replaces the pod: the music stops for the seconds the old pod takes to stop and the new one to start, and
every server comes back paused where it was. The queues, the history and the cache stay on the volume, and the
database moves to a newer schema by itself on the first start; an older jukecord refuses a database a newer one has
written, so going back means restoring the backup made before. The values file is given again with each upgrade
(`--reuse-values` would keep the older chart's defaults). The volume outlives an uninstall; delete its PVC to remove
the data.

## More

[jukecord on Kubernetes](https://github.com/kanggu12/jukecord/blob/main/docs/KUBERNETES.md) has the Ingress (WebSocket
and its timeout), the NetworkPolicy in detail, memory and CPU, backup and restore, k3s, and testing the chart on a
kind cluster.
