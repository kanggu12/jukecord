#!/usr/bin/env bash
# The Helm chart's split mode on a throwaway kind cluster, with an image built from this checkout: a core and two edges
# over a PostgreSQL and a Valkey of their own (deploy/kind/split-services.yaml), browser-only. It installs the chart
# with the database's and the bus's addresses in Secrets of the user's kind, and the logins set up (an identity
# provider and a directory that are never asked, their secrets in a Secret of the user's and a private CA in a
# ConfigMap: jukecord reads those files as it starts, so edges that start prove the mounts). It runs `helm test` (the
# panel's Service answers ready through an edge), the jukecord command in an edge, the API through the Service with a
# token made in one edge (a database row every edge reads), checks that the logins are the edges' and not the core's,
# that only the edges reach the core's internal port, replaces the core's pod and sees the edges ready again. The
# cluster is deleted at the end, whatever happened.
#
#   deploy/kind/check-split.sh [image]        (default jukecord:dev; build it with docker build -f deploy/docker/Dockerfile)
#
# Used by .github/workflows/chart-e2e.yml and by hand. Needs docker, kind, kubectl and helm.
set -euo pipefail
cd "$(dirname "$0")/../.."
image=${1:-jukecord:dev}
cluster=${JUKECORD_KIND_CLUSTER:-jukecord-test-split-kind-$$}
release=jukecord
namespace=jukecord
kubeconfig=$(mktemp)
export KUBECONFIG=$kubeconfig

say() { printf '\n== %s\n' "$*"; }
cleanup() {
  kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  rm -f "$kubeconfig" "$kubeconfig.ca.pem"
}
trap cleanup EXIT

say "a cluster ($cluster)"
kind create cluster --name "$cluster" --config deploy/kind/cluster.yaml --wait 120s
kind load docker-image "$image" --name "$cluster"

say "a database and a bus beside it"
kubectl create namespace "$namespace"
password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
kubectl -n "$namespace" create secret generic jukecord-test-database --from-literal=password="$password"
kubectl -n "$namespace" apply -f deploy/kind/split-services.yaml
kubectl -n "$namespace" rollout status deploy/postgres --timeout 180s
kubectl -n "$namespace" rollout status deploy/valkey --timeout 180s
# Where jukecord finds them, as a user keeps such addresses: in Secrets of their own, under the key url.
kubectl -n "$namespace" create secret generic jukecord-database \
  --from-literal=url="postgres://jukecord:$password@postgres:5432/jukecord"
kubectl -n "$namespace" create secret generic jukecord-bus --from-literal=url="redis://valkey:6379"
# The logins' secrets and a private CA's certificate (made here, valid for a day), as a host keeps them.
kubectl -n "$namespace" create secret generic jukecord-logins \
  --from-literal=oidcClientSecret="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
  --from-literal=ldapBindPassword="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
openssl req -x509 -newkey rsa:2048 -nodes -keyout /dev/null -out "$kubeconfig.ca.pem" -days 1 \
  -subj /CN=jukecord-test-ca 2>/dev/null
kubectl -n "$namespace" create configmap jukecord-test-ca --from-file=ca.pem="$kubeconfig.ca.pem"

say "the chart, split"
repository=${image%:*}
tag=${image##*:}
helm install "$release" deploy/helm/jukecord --namespace "$namespace" \
  --set mode=split --set database.existingSecret=jukecord-database --set bus.existingSecret=jukecord-bus \
  --set split.edge.replicas="${JUKECORD_KIND_EDGES:-2}" \
  --set auth.oidc.issuer=https://sso.example.invalid/realms/home --set auth.oidc.clientId=jukecord \
  --set auth.oidc.existingSecret=jukecord-logins --set 'auth.oidc.adminGroups[0]=jukecord-admins' \
  --set auth.ldap.url=ldaps://ldap.example.invalid --set 'auth.ldap.baseDn=dc=example\,dc=invalid' \
  --set 'auth.ldap.bindDn=cn=jukecord\,dc=example\,dc=invalid' --set auth.ldap.existingSecret=jukecord-logins \
  --set 'auth.ldap.readGroups[0]=*' --set auth.ca.configMap=jukecord-test-ca --set auth.ca.key=ca.pem \
  --set image.repository="$repository" --set image.tag="$tag" --set image.pullPolicy=Never \
  --set persistence.size=1Gi --wait --timeout 300s
kubectl -n "$namespace" get pods,svc,pvc,networkpolicy

say "helm test"
helm test "$release" --namespace "$namespace"

say "the jukecord command in an edge"
kubectl -n "$namespace" exec "deploy/$release-edge" -- jukecord status
kubectl -n "$namespace" exec "deploy/$release-edge" -- jukecord doctor
token=$(kubectl -n "$namespace" exec "deploy/$release-edge" -- jukecord token create e2e --scope read | head -n 1)
test "${token#jkc_}" != "$token"

say "the token made in one edge works in every edge (a database row they all read)"
me="fetch('http://127.0.0.1:8795/api/v1/me',{headers:{authorization:'Bearer $token'}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
for pod in $(kubectl -n "$namespace" get pods -l app.kubernetes.io/component=edge -o name); do
  kubectl -n "$namespace" exec "$pod" -- node -e "$me"
  echo "$pod knows the token"
done

say "the API through the Service"
kubectl -n "$namespace" port-forward "svc/$release" 18795:8795 >/dev/null 2>&1 &
forward=$!
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:18795/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -H "authorization: Bearer $token" http://127.0.0.1:18795/api/v1/status
echo
curl -fsS http://127.0.0.1:18795/readyz
echo
say "the logins are the edges': both ways offered through the Service, the edges' settings in the self-check"
methods=$(curl -fsS http://127.0.0.1:18795/api/v1/auth/methods)
echo "$methods"
kill "$forward"
case "$methods" in
  *'"sso":{'*'"directory":{'*) ;;
  *)
    echo "the login page does not offer both ways" >&2
    exit 1
    ;;
esac
kubectl -n "$namespace" exec "deploy/$release-edge" -- jukecord doctor | grep -F 'sso (oidc): https://sso.example.invalid/realms/home'
kubectl -n "$namespace" exec "deploy/$release-edge" -- jukecord doctor | grep -F 'directory certificates: JUKECORD_LDAP_CA_FILE'
# The core logs nobody in: none of the logins' settings, files or certificates.
if kubectl -n "$namespace" exec "deploy/$release-core" -- printenv JUKECORD_OIDC_ISSUER >/dev/null 2>&1; then
  echo "the core has the logins' settings" >&2
  exit 1
fi
echo "the core has none of them"

say "the NetworkPolicy: the core's internal port answers its edges, and nobody else"
# Asked from an edge: reached (401: the request carries no secret, which is what this checks).
reach="fetch('http://$release-core:8796/internal/v1/audio',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status===401?0:1),()=>process.exit(3))"
kubectl -n "$namespace" exec "deploy/$release-edge" -- node -e "$reach"
echo "an edge reaches the core's internal port"
# Asked from another pod of the cluster: refused by the policy (exit 3, the fetch failed).
rc=0
kubectl -n "$namespace" run reach --image="$image" --image-pull-policy=Never --restart=Never --rm -i --quiet \
  --command -- node -e "$reach" || rc=$?
if [ "$rc" != 3 ]; then
  echo "another pod: exit $rc, not the refused fetch (3): the core's internal port is not kept to the edges" >&2
  exit 1
fi
echo "another pod does not"

say "a new core: the edges are ready again"
kubectl -n "$namespace" delete pod -l app.kubernetes.io/component=core --wait=true
kubectl -n "$namespace" rollout status "deploy/$release-core" --timeout 180s
# The edges hear the new core within a second or two of its start; each says so on its /readyz.
ready="fetch('http://127.0.0.1:8795/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
for pod in $(kubectl -n "$namespace" get pods -l app.kubernetes.io/component=edge -o name); do
  for _ in $(seq 1 30); do kubectl -n "$namespace" exec "$pod" -- node -e "$ready" && break; sleep 1; done
  kubectl -n "$namespace" exec "$pod" -- node -e "$ready"
  echo "$pod has its core again"
done
helm test "$release" --namespace "$namespace"

say "all good (split)"
