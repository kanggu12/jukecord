#!/usr/bin/env bash
# Logs in with Active Directory accounts for real: a Samba domain controller built from tests/auth/samba and started in
# a throwaway container on this machine, jukecords against it, and tests/auth/samba.test.ts. The container goes away
# at the end, whatever happened; the image stays for the next run (docker rmi jukecord-test-samba:local removes it).
#
#   tests/auth/run-ad.sh
#
# Needs Docker, openssl and Node. Listens on 127.0.0.1 only: 1389 and 1636 (LDAP and LDAPS; the same ports as
# tests/auth/run.sh's OpenLDAP, so the two run one after the other) and 18903 (the jukecord the tests start).
set -euo pipefail
cd "$(dirname "$0")/../.."
samba=jukecord-test-samba
work=$(mktemp -d)
cleanup() {
  docker rm -f "$samba" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
# A container of this name left by an earlier run that was cut short is this script's own.
docker rm -f "$samba" >/dev/null 2>&1 || true

# The domain controller's certificate for LDAPS and StartTLS, from a CA made for this run alone: for localhost and
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
chmod 0755 "$work/certs"
chmod 0644 "$work/certs"/*

docker build -q -t jukecord-test-samba:local tests/auth/samba >/dev/null
docker run -d --name "$samba" --hostname dc1 -p 127.0.0.1:1389:389 -p 127.0.0.1:1636:636 \
  -v "$work/certs:/certs:ro" jukecord-test-samba:local >/dev/null
# Ready once the domain is made and Samba has opened its LDAP port (a few seconds after).
for _ in $(seq 1 120); do
  if docker logs "$samba" 2>&1 | grep -q 'the domain is ready' && (exec 3<>/dev/tcp/127.0.0.1/1389) 2>/dev/null; then
    break
  fi
  sleep 1
done
sleep 2

JUKECORD_E2E_AD=ldap://localhost:1389 \
  JUKECORD_E2E_ADS=ldaps://localhost:1636 \
  JUKECORD_E2E_AD_CA="$work/certs/ca.crt" \
  node --disable-warning=ExperimentalWarning --test --test-reporter=spec tests/auth/samba.test.ts
