# Certificate authorities for the split

Put your own certificate authorities here (a company's, a cluster's): one PEM file with one or more certificates,
`ca.pem` say. `compose.yaml` mounts this folder read-only at `/run/jukecord-ca` in the core and every edge; name the
file in the checkout's `.env`, the settings every jukecord service reads:

```bash
JUKECORD_CA_FILE=/run/jukecord-ca/ca.pem
```

Every TLS connection jukecord makes then trusts them besides the authorities Node.js ships with: the database, a bus
over `rediss://`, an identity provider, a directory. A database's own root certificate (`sslrootcert=` in its
address) can live here too: `sslrootcert=/run/jukecord-ca/db-ca.pem`.

Certificates are no secret, but only this file is kept by git: what you put here stays yours.
