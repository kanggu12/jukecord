# syntax=docker/dockerfile:1.7
#
# The jukecord image, for linux/amd64 and linux/arm64: Node 26 LTS on Debian 13, Debian's ffmpeg (libopus, libmp3lame), and
# the official yt-dlp build for the image's architecture, checked against the release's published checksum.
#
# yt-dlp's official builds carry everything yt-dlp needs, including the scripts it runs for YouTube; they run those
# with Node (JUKECORD passes --js-runtimes node), so the image needs neither Python nor Deno.
#
#   docker build -f deploy/docker/Dockerfile -t jukecord .

# Node 26 is the current LTS (from 2026-10-28) and Debian 13 (trixie) the current stable release. Pinned by the
# multi-platform index digest, so a rebuild gets the same base on both architectures until it is bumped on purpose.
# Debian (glibc), not Alpine: musl's resolver has failed lookups in Kubernetes clusters, which the Helm chart targets.
ARG NODE_IMAGE=node:26-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

# ---- yt-dlp ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS ytdlp
# Set by buildx for each platform of a multi-platform build.
ARG TARGETARCH
# Bump all three together; the sums are the release's SHA2-256SUMS lines for the two .zip assets.
ARG YTDLP_VERSION=2026.10.26
ARG YTDLP_SHA256_AMD64=f34053415136e55073dd64ba5326d161ecc23ce0e98c081d8752867b37809450
ARG YTDLP_SHA256_ARM64=74708e707e8fa8177c8347e58152337edf320149cd7b225defd453f7cde47822
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
# The one-folder build (a .zip) starts faster than the one-file build, which unpacks itself to /tmp on every run, and
# jukecord runs yt-dlp for every lookup and every download.
RUN set -eu; \
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

# ---- npm packages ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime packages only; install scripts off, since nothing jukecord uses needs one (native parts come prebuilt).
# The folder is created even when there are no runtime packages, so the COPY below never fails on its absence.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p node_modules

# ---- the panel ------------------------------------------------------------------------------------------------------
# Built once on the machine doing the build (it is plain JavaScript and CSS, the same for every architecture), with
# the development packages (esbuild) that the image itself does not carry.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS panel
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts ./scripts
COPY panel ./panel
RUN node scripts/build-panel.ts

# ---- the image ------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# Labels the registries and scanners read; the version and revision are passed by the release workflow.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="jukecord" \
      org.opencontainers.image.description="A self-hosted Discord music bot: one queue, heard in a voice channel and in the browser" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/kanggu12/jukecord" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
# tini as PID 1 forwards SIGTERM to Node and reaps the yt-dlp and ffmpeg processes jukecord starts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Readable by jukecord's user (10001) whatever umask the checkout was made with (0755: directories need x).
COPY --chmod=0755 package.json LICENSE ./
COPY --chmod=0755 src ./src
COPY --from=panel --chmod=0755 /app/panel/dist ./panel/dist
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
# Healthy when the web server answers; Node's own fetch, as the image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.JUKECORD_PORT||8795)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# Node's SQLite driver prints an "experimental" warning on every start (Node 24 and 26); it is known and expected.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
