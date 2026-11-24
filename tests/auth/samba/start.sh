#!/bin/sh
# Makes this container the domain controller of CORP.EXAMPLE.TEST and runs it: the domain, jukecord's service account,
# people in groups for each of jukecord's levels (one through a group inside a group), and two whose right password
# Active Directory still refuses (a password to change first, an account turned off). Every name and password is made
# up.
set -eu
realm=CORP.EXAMPLE.TEST
rm -f /etc/samba/smb.conf
# NT ACLs through xattr_tdb (a database of Samba's) rather than security xattrs, which need privileges to write.
samba-tool domain provision --realm="$realm" --domain=CORP --server-role=dc --dns-backend=NONE \
  --adminpass='Admin-e2e-Passw0rd' --option='vfs objects = dfs_samba4 acl_xattr xattr_tdb' >/dev/null
# The run's certificate for LDAPS and StartTLS (for localhost, from a CA the test trusts), in place of the one Samba
# makes for its own name. Names and passwords in the clear are refused, as Active Directory with signing required does.
if [ -f /certs/ldap.crt ]; then
  install -m 0600 /certs/ldap.key /var/lib/samba/private/tls/jukecord.key
  install -m 0644 /certs/ldap.crt /var/lib/samba/private/tls/jukecord.crt
  install -m 0644 /certs/ca.crt /var/lib/samba/private/tls/jukecord-ca.crt
  sed -i '/^\[global\]/a\
\ttls enabled = yes\
\ttls keyfile = /var/lib/samba/private/tls/jukecord.key\
\ttls certfile = /var/lib/samba/private/tls/jukecord.crt\
\ttls cafile = /var/lib/samba/private/tls/jukecord-ca.crt' /etc/samba/smb.conf
fi

samba-tool user create jukecord 'Service-e2e-Passw0rd' --description="jukecord's service account" >/dev/null
samba-tool user create ada 'Ada-e2e-Passw0rd' --given-name=Ada --surname=Admin >/dev/null
samba-tool user create dan 'Dan-e2e-Passw0rd' --given-name=Dan --surname=Deejay >/dev/null
samba-tool user create lee 'Lee-e2e-Passw0rd' --given-name=Lee --surname=Listener >/dev/null
samba-tool user create sam 'Sam-e2e-Passw0rd' --given-name=Sam --surname=Stranger >/dev/null
samba-tool user create old 'Old-e2e-Passw0rd' --given-name=Old --surname=Password --must-change-at-next-login >/dev/null
samba-tool user create off 'Off-e2e-Passw0rd' --given-name=Off --surname=Switched >/dev/null
samba-tool user disable off >/dev/null

samba-tool group add jukecord-admins >/dev/null
samba-tool group add jukecord-djs >/dev/null
samba-tool group add jukecord-listeners >/dev/null
samba-tool group add 'Night Shift' >/dev/null
samba-tool group addmembers jukecord-admins ada >/dev/null
samba-tool group addmembers jukecord-djs dan,old,off >/dev/null
# Lee is in Night Shift, which is in jukecord-listeners: only the nested rule finds jukecord-listeners for Lee.
samba-tool group addmembers 'Night Shift' lee >/dev/null
samba-tool group addmembers jukecord-listeners 'Night Shift' >/dev/null

echo 'the domain is ready'
exec samba --interactive --model=single --debug-stdout
