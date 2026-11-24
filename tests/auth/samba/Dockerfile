# An Active Directory domain controller for the end-to-end logins: Debian's Samba, made a DC at its start by start.sh
# with a domain of made-up people and groups (one inside another). Runs without privileges: Samba keeps its NT ACLs in a
# database of its own instead of the security xattrs that need them.
#
#   docker build -t jukecord-test-samba:local tests/auth/samba     (tests/auth/run-ad.sh builds and runs it)
FROM debian:trixie@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends samba-ad-dc samba-ad-provision samba-vfs-modules ldb-tools \
  && rm -rf /var/lib/apt/lists/*
COPY start.sh /usr/local/bin/start-dc
ENTRYPOINT ["/usr/local/bin/start-dc"]
