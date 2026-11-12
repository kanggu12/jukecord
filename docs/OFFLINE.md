# jukecord without the internet

jukecord runs without a network connection, with fewer things working:

| Works                                                  | Needs the internet                                             |
| :----------------------------------------------------- | :------------------------------------------------------------- |
| the panel, the API and the `jukecord` command          | adding new tracks (yt-dlp asks the site)                       |
| playing tracks already in the media cache, in browsers | Discord: the bot, voice, slash commands, Discord login         |
| the queue, history, playlists and statistics           | thumbnails and avatars (they come from the sites)              |
| the host's login links                                 | checking for a newer yt-dlp (`doctor` says it could not check) |

Without a bot token jukecord runs browser-only, which needs no Discord at all; that is also how its tests run.

## Building the image without the internet

The image build downloads the Node base image, FFmpeg's source and the libraries it is built with, the npm packages
and yt-dlp's release. To run it on a
machine without access, build on one with access and move the image, with a copy of this repository:

```bash
docker build -f deploy/docker/Dockerfile -t jukecord:local .
docker save jukecord:local | gzip > jukecord.tar.gz
# on the other machine
gunzip -c jukecord.tar.gz | docker load
./jukecord up
```

`compose.yaml` uses `jukecord:local` by default, so `./jukecord up` uses the loaded image without building.

A released image works the same way: `docker pull ghcr.io/kanggu12/jukecord:0.2.1` on the machine with access, save
and load it as above, and set `JUKECORD_IMAGE=ghcr.io/kanggu12/jukecord:0.2.1` in `.env`. The image is built for amd64
and arm64; to carry it to a machine of the other kind, pull it with `--platform linux/arm64` (or `linux/amd64`).

## On Kubernetes without the internet

Fetch the chart and the image where there is access, and put the image in a registry the cluster can reach:

```bash
# on a machine with access
helm pull oci://ghcr.io/kanggu12/charts/jukecord --version 0.2.1
docker pull ghcr.io/kanggu12/jukecord:0.2.1
docker save ghcr.io/kanggu12/jukecord:0.2.1 | gzip > jukecord-image.tar.gz
# inside, where the cluster's registry is
gunzip -c jukecord-image.tar.gz | docker load
docker tag ghcr.io/kanggu12/jukecord:0.2.1 registry.example.internal/jukecord:0.2.1
docker push registry.example.internal/jukecord:0.2.1
helm install jukecord ./jukecord-0.2.1.tgz -n jukecord --create-namespace \
  --set image.repository=registry.example.internal/jukecord
```

## Moving the data

The data is one folder (`/data` in the container, the `jukecord_jukecord-data` volume with Compose).
`./jukecord backup` makes a copy of the database to move; the cache can be left behind (tracks are fetched again when
played).
