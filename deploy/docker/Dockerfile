# syntax=docker/dockerfile:1
#
# The jukecord image, for linux/amd64 and linux/arm64: Node 26 LTS on Debian 13, FFmpeg built here for audio (Opus,
# MP3), and the official yt-dlp build for the image's architecture, checked against the release's published checksum.
#
# yt-dlp's official builds carry everything yt-dlp needs, including the scripts it runs for YouTube; they run those
# with Node (JUKECORD passes --js-runtimes node), so the image needs neither Python nor Deno.
#
#   docker build -f deploy/docker/Dockerfile -t jukecord .
#
# Each step of the stages that only build (yt-dlp, FFmpeg, the npm packages, the panel) starts by echoing a line that
# begins with "jukecord:". Docker describes a step's build cache by its command, so that word is how
# `docker buildx prune --filter description~=jukecord` finds this build's cache and leaves other projects' alone.

# Node 26 is the current LTS (from 2026-10-28) and Debian 13 (trixie) the current stable release. Pinned by the
# multi-platform index digest, so a rebuild gets the same base on both architectures until it is bumped on purpose.
# Written out here and in the panel's stage, not through an ARG: Dependabot reads only FROM lines when it proposes a
# newer digest (.github/dependabot.yml). The release workflow reads this line (AS base) for the image's base labels.
# Debian (glibc), not Alpine: musl's resolver has failed lookups in Kubernetes clusters, which the Helm chart targets.
FROM node:26-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS base

# ---- yt-dlp ---------------------------------------------------------------------------------------------------------
FROM base AS ytdlp
# Set by buildx for each platform of a multi-platform build.
ARG TARGETARCH
# Before the versions below: a build argument declared before a RUN is part of that RUN's cache key, so a newer
# yt-dlp would fetch these again.
RUN echo "jukecord: the tools that fetch yt-dlp" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
# Bump all three together; the sums are the release's SHA2-256SUMS lines for the two .zip assets. A weekly check
# (.github/workflows/ytdlp-release.yml) fails when a newer release is out.
ARG YTDLP_VERSION=2026.10.26
ARG YTDLP_SHA256_AMD64=f34053415136e55073dd64ba5326d161ecc23ce0e98c081d8752867b37809450
ARG YTDLP_SHA256_ARM64=74708e707e8fa8177c8347e58152337edf320149cd7b225defd453f7cde47822
# The one-folder build (a .zip) starts faster than the one-file build, which unpacks itself to /tmp on every run, and
# jukecord runs yt-dlp for every lookup and every download.
RUN set -eu; \
    echo "jukecord: yt-dlp ${YTDLP_VERSION} for ${TARGETARCH}"; \
    case "$TARGETARCH" in \
      amd64) asset=yt-dlp_linux.zip; sum="$YTDLP_SHA256_AMD64" ;; \
      arm64) asset=yt-dlp_linux_aarch64.zip; sum="$YTDLP_SHA256_ARM64" ;; \
      *) echo "yt-dlp publishes no build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/yt-dlp.zip "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
    echo "${sum}  /tmp/yt-dlp.zip" | sha256sum -c -; \
    mkdir -p /opt/yt-dlp; \
    unzip -q /tmp/yt-dlp.zip -d /opt/yt-dlp; \
    exe=$(find /opt/yt-dlp -maxdepth 1 -type f -name 'yt-dlp_linux*'); \
    chmod 0755 "$exe"; \
    ln -s "$exe" /opt/yt-dlp/yt-dlp; \
    rm /tmp/yt-dlp.zip

# ---- FFmpeg ---------------------------------------------------------------------------------------------------------
# FFmpeg for what jukecord asks of it: reading the audio of whatever yt-dlp brings (from a pipe, or over https when
# yt-dlp hands a stream to FFmpeg), evening out its loudness, and writing Ogg Opus and MP3. Every demuxer, decoder,
# parser, protocol, muxer and audio filter of FFmpeg's own stays in; devices, video scaling, encoders other than Opus,
# MP3 and PCM, and every outside library but the four below are left out. Debian's package brings the libraries of
# every codec and device it supports (about 450 MB); this is a single program of a few dozen MB. No GPL parts:
# LGPL-3.0-or-later (version 3 for OpenSSL's licence).
FROM base AS ffmpeg
# Before the version below, so a newer FFmpeg reuses the compilers from the cache.
RUN echo "jukecord: the tools FFmpeg is built with" \
 && apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl nasm pkg-config xz-utils \
      libmp3lame-dev libopus-dev libssl-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
# Bump both together. The sum is of the release's .tar.xz, whose signature was checked against FFmpeg's release
# signing key (FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8, https://ffmpeg.org/ffmpeg-devel.asc) when pinned.
ARG FFMPEG_VERSION=7.1.5
ARG FFMPEG_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
RUN set -eu; \
    echo "jukecord: FFmpeg ${FFMPEG_VERSION}, for audio"; \
    curl -fsSL --retry 3 -o /tmp/ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"; \
    echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir /tmp/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1; \
    cd /tmp/ffmpeg; \
    ./configure --prefix=/opt/ffmpeg \
      --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
      --disable-autodetect --disable-avdevice --disable-swscale --disable-postproc \
      --disable-encoders --enable-encoder=libopus,libmp3lame,pcm_s16le,pcm_f32le \
      --enable-version3 --enable-openssl --enable-zlib --enable-libopus --enable-libmp3lame; \
    make -j"$(nproc)"; \
    # The program alone (make install would add the static libraries and headers, 56 MB of build cache), stripped, and
    # its licence with where its source is, as the image carries it.
    install -D -m 0755 ffmpeg /opt/ffmpeg/bin/ffmpeg; \
    strip /opt/ffmpeg/bin/ffmpeg; \
    install -D -m 0644 LICENSE.md /opt/ffmpeg/share/doc/ffmpeg/LICENSE.md; \
    install -D -m 0644 COPYING.LGPLv3 /opt/ffmpeg/share/doc/ffmpeg/COPYING.LGPLv3; \
    printf 'FFmpeg %s, built for jukecord from https://ffmpeg.org/releases/ffmpeg-%s.tar.xz (sha256 %s).\n%s\n' \
      "$FFMPEG_VERSION" "$FFMPEG_VERSION" "$FFMPEG_SHA256" "$(/opt/ffmpeg/bin/ffmpeg -hide_banner -version | grep '^configuration:')" \
      > /opt/ffmpeg/share/doc/ffmpeg/SOURCE; \
    rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz; \
    /opt/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -q libopus; \
    /opt/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -q libmp3lame; \
    /opt/ffmpeg/bin/ffmpeg -hide_banner -protocols | grep -qx '  https'

# ---- npm packages ---------------------------------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime packages only; install scripts off, since nothing jukecord uses needs one (native parts come prebuilt).
# The folder is created even when there are no runtime packages, so the COPY below never fails on its absence.
RUN echo "jukecord: the npm packages it runs" \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p node_modules

# ---- the panel ------------------------------------------------------------------------------------------------------
# Built once on the machine doing the build (it is plain JavaScript and CSS, the same for every architecture), with
# the development packages (esbuild) that the image itself does not carry. The same base as above, for the machine's
# own processor.
FROM --platform=$BUILDPLATFORM node:26-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS panel
WORKDIR /app
COPY package.json package-lock.json ./
RUN echo "jukecord: the tools the panel is built with" \
 && npm ci --ignore-scripts --no-audit --no-fund
COPY scripts ./scripts
COPY panel ./panel
# The files outside panel/ that the panel's code imports: the refusals and failures in a person's language, which the
# bot and the panel share, and the reasons they translate. Each lands where it is in the checkout, so the panel's
# ../../../src/core imports resolve here as they do there (tests/packaging checks that every such import is copied).
COPY src/core/say.ts src/core/reasons.ts ./src/core/
RUN echo "jukecord: the panel" \
 && node scripts/build-panel.ts

# ---- the image ------------------------------------------------------------------------------------------------------
FROM base AS runtime
# tini as PID 1 forwards SIGTERM to Node and reaps the yt-dlp and ffmpeg processes jukecord starts. libopus and LAME
# are the two libraries FFmpeg was built against that the base does not have (OpenSSL comes with ca-certificates).
# npm and npx go: jukecord installs nothing while it runs, and a package manager is a tool for anyone who gets in
# (and what scanners report on). No program keeps a setuid or setgid bit (passwd, su, mount ...): jukecord's user never
# takes on another's rights, which Compose and the chart forbid anyway.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini libopus0 libmp3lame0 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /opt/ffmpeg/share/doc/ffmpeg /usr/local/share/doc/ffmpeg
# The program starts with the libraries this stage has (a missing one fails the build here, not at the first track).
RUN ffmpeg -hide_banner -encoders | grep -q libopus
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Readable by jukecord's user (10001) whatever umask the checkout was made with, and not executable: files 644,
# folders 755 (X gives execute to folders, and to nothing else here).
COPY --chmod=u=rwX,go=rX package.json LICENSE ./
COPY --chmod=u=rwX,go=rX src ./src
COPY --from=panel --chmod=u=rwX,go=rX /app/panel/dist ./panel/dist
# Inside a container the panel listens on every interface (compose publishes it on 127.0.0.1); data lives in /data.
ENV NODE_ENV=production \
    JUKECORD_HOST=0.0.0.0 \
    JUKECORD_DATA_DIR=/data \
    JUKECORD_YTDLP=/opt/yt-dlp/yt-dlp
# The jukecord command on the PATH: `docker compose exec jukecord jukecord np` (and the front door) use it. It finds
# the host token in /data, so commands run inside the container need no login.
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/src/cli/main.ts "$@"\n' > /usr/local/bin/jukecord \
 && chmod 0755 /usr/local/bin/jukecord
# A fixed non-root user, the same number the Helm chart's securityContext uses.
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8795
# Healthy when the web server answers; Node's own fetch, as the image has no curl. Once a minute: each check starts a
# Node of its own (about 60 MB for a moment). While the container starts, Docker 25 and newer check every 5 s (their
# default start interval), so it shows healthy within seconds all the same.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.JUKECORD_PORT||8795)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Labels the registries and scanners read. Here at the end: the version and revision change with every release, and
# a build argument declared before a RUN makes that RUN (and every one after it) run again instead of coming from the
# cache. The release workflow passes both, and adds as labels when it was built and the base it was built on.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="jukecord" \
      org.opencontainers.image.description="A self-hosted Discord music bot: one queue, heard in a voice channel and in the browser" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/kanggu12/jukecord" \
      org.opencontainers.image.source="https://github.com/kanggu12/jukecord" \
      org.opencontainers.image.documentation="https://github.com/kanggu12/jukecord/tree/main/docs" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Node's SQLite driver prints an "experimental" warning on every start (Node 24 and 26); it is known and expected.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
