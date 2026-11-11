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

The image build downloads the Node base image, Debian's ffmpeg, the npm packages and yt-dlp's release. To build on a
machine without access, build on one with access and move the image:

```bash
docker build -f deploy/docker/Dockerfile -t jukecord:local .
docker save jukecord:local | gzip > jukecord.tar.gz
# on the other machine
gunzip -c jukecord.tar.gz | docker load
./jukecord up
```

`compose.yaml` uses `jukecord:local` by default, so `./jukecord up` uses the loaded image without building.

## Moving the data

The data is one folder (`/data` in the container, the `jukecord-data` volume with Compose). `./jukecord backup` makes
a copy of the database to move; the cache can be left behind (tracks are fetched again when played).
