#!/usr/bin/env bash
# The Helm chart on a throwaway kind cluster, with an image built from this checkout: what only a running cluster
# shows. It installs the chart (browser-only: no bot token), runs `helm test`, checks the panel and the jukecord
# command through the cluster, that the data survives a new pod, that the NetworkPolicy keeps the pod away from the
# cluster's private networks while names resolve and the internet stays in reach, and that an uninstall keeps the
# volume for a reinstall to pick up. The cluster is deleted at the end, whatever happened.
#
#   deploy/kind/check.sh [image]        (default jukecord:dev; build it with docker build -f deploy/docker/Dockerfile)
#
# Used by .github/workflows/chart-e2e.yml and by hand. Needs docker, kind, kubectl and helm.
set -euo pipefail
cd "$(dirname "$0")/../.."
image=${1:-jukecord:dev}
cluster=jukecord-e2e-$$
release=jukecord
namespace=jukecord
kubeconfig=$(mktemp)
export KUBECONFIG=$kubeconfig

say() { printf '\n== %s\n' "$*"; }
cleanup() {
  kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  rm -f "$kubeconfig"
}
trap cleanup EXIT

say "a cluster ($cluster)"
kind create cluster --name "$cluster" --config deploy/kind/cluster.yaml --wait 120s
kind load docker-image "$image" --name "$cluster"

say "the chart"
repository=${image%:*}
tag=${image##*:}
helm install "$release" deploy/helm/jukecord --namespace "$namespace" --create-namespace \
  --set image.repository="$repository" --set image.tag="$tag" --set image.pullPolicy=Never \
  --set persistence.size=1Gi --wait --timeout 180s
kubectl -n "$namespace" get pods,svc,pvc,networkpolicy

say "helm test"
helm test "$release" --namespace "$namespace"

say "the jukecord command inside the pod"
kubectl -n "$namespace" exec "deploy/$release" -- jukecord status
kubectl -n "$namespace" exec "deploy/$release" -- jukecord doctor
link=$(kubectl -n "$namespace" exec "deploy/$release" -- jukecord link)
printf 'a login link: %s\n' "${link%/*}/..."
token=$(kubectl -n "$namespace" exec "deploy/$release" -- jukecord token create e2e --scope read | head -n 1)
test "${token#jkc_}" != "$token"

say "the API through a port-forward"
kubectl -n "$namespace" port-forward "svc/$release" 18795:8795 >/dev/null 2>&1 &
forward=$!
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:18795/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:18795/api/v1/status
echo
curl -fsS -H "authorization: Bearer $token" http://127.0.0.1:18795/api/v1/me
echo
kill "$forward"

say "the data survives a new pod"
kubectl -n "$namespace" delete pod -l app.kubernetes.io/instance="$release" --wait=true
kubectl -n "$namespace" rollout status "deploy/$release" --timeout 120s
kubectl -n "$namespace" exec "deploy/$release" -- jukecord token list | grep -q e2e
echo "the token made before the restart is still there"

say "the NetworkPolicy: another pod of the cluster is out of reach"
# The cluster's DNS pod answers its metrics port to anyone; jukecord's pod may ask it names (port 53) and nothing else.
dns=$(kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].status.podIP}')
reach="fetch('http://$dns:9153/metrics',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(3))"
# First from a pod without the policy, which shows the target answers at all (or the next check proves nothing).
kubectl -n "$namespace" run reach --image="$image" --image-pull-policy=Never --restart=Never --rm -i --quiet \
  --command -- node -e "$reach"
echo "a pod outside the policy reaches $dns:9153"
# Exit 3 is the fetch refused; anything else (0: it got through, other codes: kubectl itself failed) proves nothing.
rc=0
kubectl -n "$namespace" exec "deploy/$release" -- node -e "$reach" || rc=$?
if [ "$rc" != 3 ]; then
  echo "jukecord's pod: exit $rc, not the refused fetch (3): the NetworkPolicy is not shown to work" >&2
  exit 1
fi
echo "jukecord's pod does not: blocked, as it should be"

say "the NetworkPolicy: names resolve and the internet is in reach"
# What the policy must let through, or the tracks and Discord would be out of reach as well: a name looked up through
# the cluster's DNS and a public address fetched (example.com, kept for examples by IANA). Tried a few times: a policy
# takes a moment to apply and a network a moment to answer. A policy that shut everything out would pass the check
# above and fail here.
out="fetch('https://example.com/',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(3))"
reached=1
for _ in 1 2 3; do
  if kubectl -n "$namespace" exec "deploy/$release" -- node -e "$out"; then
    reached=0
    break
  fi
  sleep 3
done
if [ "$reached" != 0 ]; then
  echo "jukecord's pod cannot fetch https://example.com: the policy (or the cluster's own network) shuts the internet out" >&2
  exit 1
fi
echo "jukecord's pod reaches https://example.com"

say "an uninstall keeps the volume, and a reinstall picks it up"
helm uninstall "$release" --namespace "$namespace" --wait
kubectl -n "$namespace" get pvc
helm install "$release" deploy/helm/jukecord --namespace "$namespace" \
  --set image.repository="$repository" --set image.tag="$tag" --set image.pullPolicy=Never \
  --set persistence.size=1Gi --wait --timeout 180s >/dev/null
kubectl -n "$namespace" exec "deploy/$release" -- jukecord token list | grep -q e2e
echo "the token made before the uninstall is still there"

say "all good"
