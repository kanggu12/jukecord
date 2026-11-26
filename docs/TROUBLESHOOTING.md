# Troubleshooting

For the host, when something does not work. Start with `./jukecord doctor` (inside a pod, `jukecord doctor`): it
checks the data directory, the database, ffmpeg, yt-dlp, the cache, Discord and the logins, and says which part fails.

## "Sign in to confirm you're not a bot"

YouTube asks machines it distrusts, often servers and VPNs, to sign in. Give yt-dlp the cookies of a browser that is
signed in to YouTube:

1. In that browser, export the cookies for youtube.com in Netscape format (a "cookies.txt" export extension does it).
2. With Compose, copy the file into the volume. Docker gives the copy the file's own permissions, so make it readable
   first:

   ```bash
   chmod 644 cookies.txt && docker compose cp cookies.txt jukecord:/data/cookies.txt
   ```

3. Set `JUKECORD_YTDLP_COOKIES=/data/cookies.txt` in `.env`, then run `./jukecord up`.

jukecord gives yt-dlp a private copy, so the file itself never changes. Cookies expire: export them again when the
message comes back.

## A track does not play

The player names the track and says why in one sentence ("Could not play Neon Rain because the site does not have
it"): the video is unavailable (private, deleted, age-restricted, for members only, or not in this country), it has
not started yet (a premiere, a live stream to come), there is nothing to play at its address, or the site turned it
away (it does not have it, has removed it, blocks it, asked jukecord to slow down, or is having trouble). The site's
own message, from yt-dlp, is in `./jukecord logs`.

- A failure that looks passing (a 5xx answer, a timeout) is tried once more by itself.
- A track longer than `JUKECORD_TRACK_MAX` is refused when it is added.
- A looping queue keeps a failed track for its next pass, and lets it go when it fails again there, or at once when
  the failure will not change (removed, private, nothing to play).
- Three tracks in a row that fail stop the player and leave the queue as it was: the network or the site is then the
  cause.

## The bot does not join or is silent

- It needs the **View Channels**, **Connect** and **Speak** permissions in that channel; jukecord says which one is
  missing.
- Voice uses UDP to Discord's voice servers. A firewall or a NetworkPolicy that lets only TCP 443 out lets the bot log
  in and join, but no sound arrives. The chart's policy allows the internet on every port.
- `JUKECORD_LOG_LEVEL=debug` logs how much sound went out at the end of each track (`voice stream ended ... sentMs`).

## "Listen here" stays silent

Browsers play sound only after a click on the page: press **Listen here** again if the bar says the browser held the
sound back. Safari versions without Ogg Opus get an MP3 copy by themselves.

## Logging in with Discord fails

- **A `redirect_uri` error**: **Redirects** must hold exactly `<JUKECORD_PUBLIC_URL>/auth/callback`, or
  `http://localhost:<JUKECORD_PORT>/auth/callback` without a public address.
- **"You are not in a server that jukecord is in"**: the bot must be in a server you are a member of.
- **Behind a reverse proxy**: set `JUKECORD_PUBLIC_URL` to the proxy's address, and `JUKECORD_TRUST_PROXY=1`.

## "Too many live connections"

The panel says why jukecord turned its live connection away, and tries again by itself a little later.

- **"from this address"**: every browser seems to come from one address, which is how a reverse proxy looks when
  jukecord is not told about it. Set `JUKECORD_TRUST_PROXY` (`1` for one proxy) so each browser counts as itself;
  twenty connections per address are allowed.
- **"for this login"**: one browser or API token has ten live connections open; close a few of its tabs.
- **"jukecord has as many live connections as it allows"**: `JUKECORD_LIVE_MAX` (1000) are open. A machine that can
  take more can be given a higher one.

## "Turned connections away from one address at its cap"

jukecord takes at most 256 connections from one address. The address in the log line is where they came from: a
reverse proxy on the same machine, or Docker's bridge (`172.17.0.1`, how a client of the host looks inside the
container), carries every browser on one address. With `JUKECORD_TRUST_PROXY` set, each browser counts by its own
address for the rates and the live connections, and the proxy's address may have 3840: all but a sixteenth of the 4096
jukecord takes, the rest staying free for health checks and other clients.

## "jukecord cannot reach the internet"

Adding or playing a track says so when the machine reaches no site: no name server answers, there is no route out, or
a proxy refuses the connection. `./jukecord doctor` fails the same way on yt-dlp's release on GitHub. Once the network
is back, adding works again; a track that failed in a looping queue stays in it.

## jukecord does not start

It prints every settings problem at once and exits with code 2. "the database is at schema N, newer than this jukecord
knows" means a newer jukecord wrote it: run the newer version, or restore a backup
([below](#the-database-is-at-schema-n)). "settings.json is not JSON" (or "cannot be read") names the data folder's
file of saved settings: put back the one jukecord wrote, or remove it to start on the environment and the defaults
(its saved secrets go with it). A saved value the start refuses does not stop it: the **Settings** page shows it with
the reason, and its default applies.

## "jukecord cannot reach its database"

At its start jukecord waits up to a minute for a database server, saying each try and why in the log
(`./jukecord logs -f`), then logs this line with the reason and exits 1; Docker's restart policy or Kubernetes starts it
again. The reason names the database without its user or password:

- **nothing answers at** the host and port: the server is down, or that is not its port. A database beside jukecord in
  `compose.override.yaml` starts with `./jukecord up`.
- **the host name ... is not known**: a typo, or a name only another network knows.
- **the user name or password was refused**: a password with `@ : / ? # %` in it must be percent-encoded in the
  address ([the address](INSTALL.md#the-address)).
- **has no database** or **is in LATIN1, not UTF8**: make the database as [installing](INSTALL.md#the-database) says.
- **TLS ... failed**: `verify-full` wants the address's host name to be the certificate's. A certificate signed by an
  authority jukecord does not trust ends with "to trust the authority that signed it, name its certificate in
  JUKECORD_CA_FILE": put that authority in `JUKECORD_CA_FILE`
  ([your own certificate authorities](INSTALL.md#your-own-certificate-authorities)), or name it for the database alone
  with `sslrootcert` in the address.

`./jukecord db status <address>` tries an address and says the same, without starting jukecord.

## "impossible to write to binary log"

"Cannot execute statement: impossible to write to binary log since BINLOG_FORMAT = STATEMENT" comes from a MySQL or
MariaDB that logs statements as they are: jukecord writes at `READ COMMITTED`, which such a server refuses. Set
`binlog_format` to `ROW` (MySQL's default) or `MIXED` (MariaDB's), in the server's configuration or with
`SET PERSIST binlog_format = 'ROW'` on MySQL, and start jukecord again: it finishes its tables where it stopped.

## The database went away while jukecord ran

The requests that needed it fail (the API answers 500, the log says `a request failed` with the reason), `/readyz`
answers 503 and the panel says jukecord is not ready. jukecord keeps running and opens new connections when the
server answers again; nothing needs restarting. A connection that the server ended while idle is only a warning in the
log: `a connection to the database was lost while idle; a new one is opened when needed`.

## "the database is at schema N"

- **newer than this jukecord knows**: a newer jukecord moved the database on. Run the newer one, or restore the backup
  taken before the update. In a split every service runs the same version: an older edge reports its database down.
- **older than this jukecord's** (from `jukecord db copy` or `db status`): start this jukecord on it once, and it brings
  the database up to date.
- **the database already has tables jukecord did not make**: give jukecord an empty database, or on PostgreSQL a schema
  of its own (`?schema=jukecord` in the address).
- **the target already holds jukecord's data** (from `jukecord db copy`): `--replace` empties it first, in the same
  transaction as the copy.

## An edge answers 503, or the panel keeps reconnecting

In a split an edge has nothing to serve while it hears no core, and says so on `/readyz`
(`docker compose -f deploy/split/compose.yaml exec edge1 jukecord status`, or the edge's log):

- **core** is down: the core is not running, is restarting, or listens on another bus. Its log says why
  (`docker compose -f deploy/split/compose.yaml logs core`). A second core waits while one runs ("another core runs on
  this bus"); it takes over when the first stops.
- **bus** is down: the service cannot reach Redis or Valkey at `JUKECORD_BUS_URL`.
- "the core refuses this edge: JUKECORD_INTERNAL_SECRET is not the same on both": the audio and the covers stay away
  until the core and every edge are given the same secret.

When the core comes back, the panels reconnect by themselves and the music is where it was, paused.

## Logging in with SSO fails

`./jukecord auth test-oidc` reads the provider's document and keys and tries the client and its secret, logging nobody
in. The login page's message then points at the rest:

- **The provider says the redirect is not valid**: its client must list `<JUKECORD_PUBLIC_URL>/auth/sso/callback`
  exactly. Behind a reverse proxy, `JUKECORD_PUBLIC_URL` is the proxy's address.
- **"The sign-in service did not let the login through"**: the log says the provider's own words. A wrong client secret
  is Keycloak's `unauthorized_client`; an issuer must be written exactly as the provider names itself, a trailing slash
  too.
- **"Your account is in none of the groups jukecord lets in"**: the person's groups are not in the tokens, or not in the
  claim jukecord reads. In Keycloak, the client's Group Membership mapper adds them to the ID token and the userinfo; a
  realm role reaches the userinfo only with **Add to userinfo** on the `realm roles` mapper
  ([Keycloak, step by step](INSTALL.md#keycloak-step-by-step)).
- **"That login took over 10 minutes or began in another browser"**: log in again from the login page.

## Logging in with a directory account fails

`./jukecord auth test-ldap <name>` connects, binds as the service account, finds that person and says their groups and
the level they give, without asking for a password:

- **"takes names and passwords over an encrypted connection only"**: Active Directory with LDAP signing, and Samba,
  refuse a password sent in the clear. Use `ldaps://`, or `JUKECORD_LDAP_STARTTLS=yes`.
- **A certificate the connection does not trust** ("name its certificate in JUKECORD_CA_FILE"): put the authority that
  signed the directory's certificate in `JUKECORD_CA_FILE`, or in `JUKECORD_LDAP_CA_FILE` for the directory alone.
- **"Wrong name or password" for a right password**: Active Directory refused it for another reason (an expired
  password, one to be changed first, an account turned off, expired or locked). The log says which: `a directory login
  did not go through`, with `reason=expired` or `reason=disabled`.
- **No groups**: the directory keeps no `memberOf` for that person (OpenLDAP keeps it with its memberof overlay):
  `JUKECORD_LDAP_GROUP_FILTER` finds the groups by a search instead. `JUKECORD_LDAP_NESTED_GROUPS` works with Active
  Directory only.
- **Nobody is found**: the service account may not be allowed to read people and groups, which a directory's default
  access can hide from it.
- **"The directory has more than one account by that name"**: the user filter is too wide; narrow it, as
  `(&(objectClass=user)(sAMAccountName={username}))`.

## /metrics answers 401 or 404

- **401**: the scraper shows a token that is not `JUKECORD_METRICS_TOKEN`. With the chart, the ServiceMonitor sends the
  `metricsToken` of the release's Secret, or of `metrics.existingSecret`.
- **404**: the request came through a proxy (it carries `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Via`,
  `X-Forwarded-Host` or `X-Forwarded-Proto`) or from a public address, and showed no token. Scrape jukecord from its
  own network, or give the scraper the token ([monitoring](INSTALL.md#monitoring)).

## jukecord started again by itself

`the main thread has not answered for 30 s; ending the process so that it is started again` in `./jukecord logs -f`,
and `the watchdog ended the last run` in `./jukecord logs` once it is back, mean jukecord was stuck and ended itself, so
that Docker's restart policy or Kubernetes would start it again: Docker restarts a container that exits, not one that
hangs. Every server comes back paused where it was, and a server with an alerts channel is told. The lines before it
say what it was doing; please put them in an issue.

## The port is taken

Set another in `.env`, for example `JUKECORD_PORT=8796`, then run `./jukecord up`.
