# jukecord Helm chart

[jukecord](https://github.com/kanggu12/jukecord) is a self-hosted Discord music bot whose queue you also hear in the
browser: one queue per Discord server, played in its voice channel and, for anyone who presses **Listen here**, in
their browser at the same place in the track. This chart runs it on Kubernetes, on amd64 and arm64 nodes, k3s and
Raspberry Pi clusters included.

## What it deploys

| Object         | What for                                                                                                                           |
| :------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| Deployment     | one pod (a bot token allows one Discord session), replaced with `Recreate` so two never run                                        |
| Service        | the panel, the HTTP API and the live updates, on port 8795                                                                         |
| PVC            | the database (SQLite, unless `database` names a server), the media cache and the logs; kept when the release is uninstalled        |
| Secrets        | the bot's token and the OAuth secret, the database's address, the logins' secrets and the metrics token, when the values give them |
| Ingress        | the panel from outside the cluster, when `ingress.enabled`                                                                         |
| NetworkPolicy  | in: the panel's port; out: DNS, the internet and the database, none of the cluster's other private ranges                          |
| ServiceMonitor | the Prometheus Operator's scrape of `/metrics`, when `metrics.serviceMonitor.enabled`                                              |
| Test pod       | `helm test`: the panel answers through the Service                                                                                 |

In split mode the Deployment is two: `<release>-core`, one pod with the volume, and `<release>-edge`, as many as you
like (a HorizontalPodAutoscaler when asked), with a Service for the core and a Secret for the internal secret the core
and its edges share.

The pod runs as user 10001 with a read-only root filesystem, no capabilities and no Kubernetes API token. The bot's
token, the OAuth secret and the chart's other secrets reach jukecord as mounted files, out of the environment that
yt-dlp and ffmpeg start with.

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
token=YOUR_BOT_TOKEN secret=YOUR_OAUTH_SECRET
kubectl create namespace jukecord
kubectl -n jukecord create secret generic jukecord-discord \
  --from-literal=token="$token" --from-literal=clientSecret="$secret"
helm install jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
kubectl -n jukecord exec deploy/jukecord -- jukecord link
```

The last line prints a one-time login link for the host. Without a bot token jukecord plays in the browser only.
`kubectl -n jukecord exec deploy/jukecord -- jukecord doctor` checks every part it needs.

## Values

| Value                                                                                        |                       Default                       | Sets                                                                          |
| :------------------------------------------------------------------------------------------- | :-------------------------------------------------: | :---------------------------------------------------------------------------- |
| `image.repository`, `image.tag`                                                              | `ghcr.io/kanggu12/jukecord`, the chart's appVersion | the image: another registry's copy, or your own build                         |
| `discord.existingSecret`                                                                     |                                                     | a Secret with `token` and `clientSecret`                                      |
| `discord.token`, `discord.clientSecret`                                                      |                                                     | the same in the values; the chart makes the Secret                            |
| `discord.clientId`                                                                           |                                                     | the application's ID, for logging in with Discord                             |
| `publicUrl`                                                                                  |                                                     | the panel's address, for logins and the bot's links                           |
| `database.url`                                                                               |                SQLite in the volume                 | a database server: `postgres://…`, `mysql://…`                                |
| `database.existingSecret`                                                                    |                                                     | a Secret with that address under `url`                                        |
| `auth.oidc.issuer`, `.clientId`                                                              |                         off                         | logging in through your identity provider (OIDC)                              |
| `auth.oidc.clientSecret`, `.existingSecret`                                                  |                                                     | its secret, or a Secret holding it as `oidcClientSecret`                      |
| `auth.oidc.scopes`, `.groupsClaim`, `.label`, `.discordClaim`                                |                                                     | what is asked of the provider, and the login key                              |
| `auth.oidc.adminGroups`, `.controlGroups`, `.readGroups`                                     |                                                     | who may log in, as what (lists)                                               |
| `auth.ldap.url`, `.startTls`, `.baseDn`, `.userFilter`                                       |                         off                         | logging in with directory accounts (LDAP)                                     |
| `auth.ldap.bindDn`, `.bindPassword`, `.existingSecret`                                       |                                                     | the service account; a Secret holds `ldapBindPassword`                        |
| `auth.ldap.groupFilter`, `.groupBaseDn`, `.nestedGroups`, `.timeout`, `.label`               |                                                     | how groups are found, and the form's key                                      |
| `auth.ldap.adminGroups`, `.controlGroups`, `.readGroups`                                     |                                                     | who may log in, as what (lists)                                               |
| `auth.ca.secret` or `.configMap`, `.key`                                                     |                      `ca.crt`                       | a private CA's certificates, for both                                         |
| `auth.egressTo`                                                                              |                                                     | NetworkPolicy rules to the provider and the directory                         |
| `env`                                                                                        |                        `{}`                         | jukecord's settings by name, as strings                                       |
| `extraEnv`                                                                                   |                        `[]`                         | more variables as Kubernetes writes them                                      |
| `ingress.enabled`, `.host`, `.className`, `.annotations`, `.tls`                             |                         off                         | the panel from outside the cluster                                            |
| `persistence.enabled`, `.size`, `.storageClass`, `.existingClaim`                            |                      on, `5Gi`                      | the data volume                                                               |
| `networkPolicy.enabled`, `.ingressFrom`, `.privateRanges`                                    |           on, anyone, the private ranges            | who may reach the panel's port, and what jukecord may not                     |
| `metrics.token`, `metrics.existingSecret`                                                    |                                                     | a token a scraper shows for `/metrics`, or a Secret with it as `metricsToken` |
| `metrics.serviceMonitor.enabled`, `.labels`, `.interval`, `.scrapeTimeout`, `.force`         |                    off, 30s, 10s                    | a ServiceMonitor for the Prometheus Operator                                  |
| `metrics.podAnnotations`                                                                     |                         off                         | `prometheus.io/scrape` annotations on the pods                                |
| `resources`                                                                                  |              250m, 512Mi; limit 1536Mi              | requests and limits                                                           |
| `service.type`, `.port`                                                                      |                 `ClusterIP`, `8795`                 | the Service                                                                   |
| `podLabels`, `podAnnotations`, `nodeSelector`, `tolerations`, `affinity`, `imagePullSecrets` |                                                     | the usual pod settings                                                        |
| `mode`                                                                                       |                      `single`                       | `single`: one pod; `split`: one core and edges                                |
| `bus.url`, `bus.existingSecret`                                                              |                                                     | the Redis or Valkey server of the services (split)                            |
| `split.existingSecret`                                                                       |                    made and kept                    | the internal secret the core and edges share                                  |
| `split.edge.replicas`, `.autoscaling.*`                                                      |                       2, off                        | how many edges, or a HorizontalPodAutoscaler                                  |
| `split.core.resources`, `split.edge.resources`                                               |             as `resources`; 100m, 192Mi             | the core's and the edges' requests and limits                                 |
| `networkPolicy.egressTo`                                                                     |      the namespace's 5432, 3306 (split: 6379)       | where the database and the bus are, when not there                            |

- The pod does not start without the Secret's `token`; its `clientSecret` is read when a client ID is set.
  `existingSecret` and the values' secrets are refused together.
- `discord.clientId` is a string: it is a long number.
- `env` takes values such as `JUKECORD_CACHE_MAX: 8GiB`; the secrets and the names the chart sets are refused there.
  `extraEnv` takes `NODE_OPTIONS`, `TZ` or a value from a ConfigMap.
- Node's heap ceiling is about half the memory limit.
- helm test's pod follows the pull secrets, the node selector and the tolerations.
- Every value is checked against the chart's schema, so a misspelt key fails the install. The settings jukecord reads
  are listed in [Using jukecord](https://github.com/kanggu12/jukecord/blob/main/docs/README.md#settings).
- The logins (`auth`) are given to the pods that serve browsers: the one pod, or the edges in split mode, where
  `jukecord auth test-oidc` and `test-ldap` run too (`exec deploy/<release>-edge`). Their settings are refused in `env`
  and `extraEnv`; a provider or a directory in a private range needs its rule in `auth.egressTo`.
- `mode: split` runs a core (one pod, `Recreate`, the volume) and edges (no volume) from the same image, over the
  database (`database.url`: a server, which split mode needs) and the bus the values name; the Service and the Ingress
  reach the edges, the core's Service its internal port (edges only, by the NetworkPolicy). The jukecord command runs
  in an edge: `exec deploy/<release>-edge`. The ServiceMonitor scrapes the core and every edge.

## Upgrade and uninstall

```bash
kubectl -n jukecord exec deploy/jukecord -- jukecord backup
helm upgrade jukecord oci://ghcr.io/kanggu12/charts/jukecord -n jukecord -f jukecord-values.yaml
helm uninstall jukecord -n jukecord
```

- An upgrade replaces the pod: the music stops for the seconds the old pod takes to stop and the new one to start, and
  every server comes back paused where it was.
- The queues, the history and the cache stay on the volume. The database moves to a newer schema by itself on the
  first start; an older jukecord refuses a database a newer one has written, so going back means restoring the backup
  made before.
- Give the values file again with each upgrade, so the newer chart's defaults apply where it says nothing.
  `--reuse-values` keeps the release's values as they were and gives what the newer chart adds its default: a 0.3
  release upgrades either way, and runs as before.
- The volume outlives an uninstall; delete its PVC to remove the data.

## More

[jukecord on Kubernetes](https://github.com/kanggu12/jukecord/blob/main/docs/KUBERNETES.md) has the Ingress (WebSocket
and its timeout), the NetworkPolicy in detail, memory and CPU, a database server, the logins, monitoring, split mode,
backup and restore, k3s, and testing the chart on a kind cluster.
