#!/usr/bin/env bash
# Logs in for real: a Keycloak and an OpenLDAP in throwaway containers on this machine, jukecords against them, and the
# tests in tests/auth/*.test.ts. Everything the run starts goes away at the end, whatever happened.
#
#   tests/auth/run.sh
#
# Needs Docker, openssl and Node. Listens on 127.0.0.1 only: 18080 (Keycloak), 1389 and 1636 (OpenLDAP), 18900 to 18903
# (the jukecords the tests start). The images are pinned by digest; KEYCLOAK_IMAGE and OPENLDAP_IMAGE change them.
set -euo pipefail
cd "$(dirname "$0")/../.."
keycloak_image=${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.4.7@sha256:9409c59bdfb65dbffa20b11e6f18b8abb9281d480c7ca402f51ed3d5977e6007}
openldap_image=${OPENLDAP_IMAGE:-osixia/openldap:1.5.0@sha256:18742e9c449c9c1afe129d3f2f3ee15fb34cc43e5f940a20f3399728f41d7c28}
keycloak=jukecord-test-keycloak
openldap=jukecord-test-openldap
work=$(mktemp -d)
cleanup() {
  docker rm -f "$keycloak" "$openldap" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
# Containers of these names left by an earlier run that was cut short are this script's own.
docker rm -f "$keycloak" "$openldap" >/dev/null 2>&1 || true

# The directory's certificate, from a CA made for this run alone (the image's own CA has expired): for localhost and
# 127.0.0.1, for two days.
mkdir -p "$work/certs"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/certs/ca.key" -out "$work/certs/ca.crt" -days 2 \
  -subj "/CN=jukecord e2e CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout "$work/certs/ldap.key" -out "$work/certs/ldap.csr" -subj "/CN=localhost" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' \
  >"$work/certs/ext.cnf"
openssl x509 -req -in "$work/certs/ldap.csr" -CA "$work/certs/ca.crt" -CAkey "$work/certs/ca.key" -CAcreateserial \
  -out "$work/certs/ldap.crt" -days 2 -extfile "$work/certs/ext.cnf" 2>/dev/null
# Read by the image's own user once it copies them in (--copy-service); nothing secret lives longer than the run.
chmod 0755 "$work/certs"
chmod 0644 "$work/certs"/*

# Keycloak in development mode, with the test realm imported at its start.
docker run -d --name "$keycloak" -p 127.0.0.1:18080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin-e2e-password \
  -v "$PWD/tests/auth/keycloak-realm.json:/opt/keycloak/data/import/jukecord-test-realm.json:ro" \
  "$keycloak_image" start-dev --import-realm >/dev/null

# OpenLDAP, for example.org, with the run's certificate and no client certificates asked for.
docker run -d --name "$openldap" --hostname localhost -p 127.0.0.1:1389:389 -p 127.0.0.1:1636:636 \
  -e LDAP_ORGANISATION="jukecord tests" -e LDAP_DOMAIN=example.org -e LDAP_ADMIN_PASSWORD=admin-e2e-password \
  -e LDAP_TLS_VERIFY_CLIENT=never -e LDAP_TLS_CRT_FILENAME=ldap.crt -e LDAP_TLS_KEY_FILENAME=ldap.key \
  -e LDAP_TLS_CA_CRT_FILENAME=ca.crt -v "$work/certs:/container/service/slapd/assets/certs:ro" \
  "$openldap_image" --copy-service >/dev/null

# OpenLDAP is ready once its first start is over (it starts once to set itself up, then again) and it answers.
for _ in $(seq 1 60); do
  if docker logs "$openldap" 2>&1 | grep -q 'Running /container/run/process/slapd/run' &&
    docker exec "$openldap" ldapsearch -x -H ldap://127.0.0.1 -b dc=example,dc=org -D cn=admin,dc=example,dc=org \
      -w admin-e2e-password -s base >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
# The people and groups, and what jukecord's service account may read.
docker cp tests/auth/openldap.ldif "$openldap:/tmp/e2e.ldif"
docker cp tests/auth/openldap-access.ldif "$openldap:/tmp/access.ldif"
docker exec "$openldap" ldapadd -x -H ldap://127.0.0.1 -D cn=admin,dc=example,dc=org -w admin-e2e-password \
  -f /tmp/e2e.ldif >/dev/null
docker exec "$openldap" ldapmodify -Q -Y EXTERNAL -H ldapi:/// -f /tmp/access.ldif >/dev/null

# Keycloak is ready once the realm's discovery document answers (it takes half a minute or so).
for _ in $(seq 1 120); do
  curl -fsS http://127.0.0.1:18080/realms/jukecord-test/.well-known/openid-configuration >/dev/null 2>&1 && break
  sleep 1
done

JUKECORD_E2E_KEYCLOAK=http://127.0.0.1:18080/realms/jukecord-test \
  JUKECORD_E2E_LDAP=ldap://localhost:1389 \
  JUKECORD_E2E_LDAPS=ldaps://localhost:1636 \
  JUKECORD_E2E_LDAP_CA="$work/certs/ca.crt" \
  node --disable-warning=ExperimentalWarning --test --test-reporter=spec "tests/auth/*.test.ts"
