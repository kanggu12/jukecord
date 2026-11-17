# syntax=docker/dockerfile:1
#
# FFmpeg for the release's programs on Linux and Windows, built by ffmpeg.sh (beside this file) in a container that
# has the compilers for it: Alpine for Linux, whose musl makes a static program that runs on any distribution, and
# llvm-mingw on Debian for Windows on x64 and arm64. build-ffmpeg.sh builds one stage for one target and takes its
# files; the macOS ones are built on a Mac, outside Docker.
#
#   docker buildx build --target linux --platform linux/arm64 --build-arg TARGET=linux-arm64 \
#     --build-arg FFMPEG_VERSION=7.1.5 --build-arg FFMPEG_SHA256=... --output type=local,dest=out deploy/bundle
#
# As in the image's Dockerfile, every stage with steps is named jukecord-something and each step starts by echoing a
# line that begins with "jukecord:", so `docker buildx prune --filter description~=jukecord` finds this build's cache
# too. The bases are pinned by their multi-platform index digest; Dependabot proposes newer ones.

# ---- Linux ----------------------------------------------------------------------------------------------------------
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS jukecord-ffmpeg-linux
# The compilers, and perl for OpenSSL's configure. nasm is for FFmpeg's x86 assembly, so only on x86-64. Before the
# versions below, so a newer FFmpeg reuses them from the cache.
RUN echo "jukecord: the tools FFmpeg is built with for Linux" \
 && apk add --no-cache build-base curl linux-headers perl pkgconf tar xz \
 && if [ "$(uname -m)" = x86_64 ]; then apk add --no-cache nasm; fi
COPY --chmod=0755 ffmpeg.sh /usr/local/bin/jukecord-ffmpeg.sh
ARG TARGET
ARG FFMPEG_VERSION
ARG FFMPEG_SHA256
RUN echo "jukecord: FFmpeg ${FFMPEG_VERSION} for ${TARGET}" \
 && jukecord-ffmpeg.sh "$TARGET" /out

# ---- Windows --------------------------------------------------------------------------------------------------------
# Built for linux/amd64 whatever machine builds it (build-ffmpeg.sh says so): llvm-mingw's compilers are programs for
# x86-64 Linux, and they build for both of Windows' processors.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS jukecord-ffmpeg-windows
# A compiler for this machine too (gcc), for the tools FFmpeg's build makes and runs on the way.
RUN echo "jukecord: the tools FFmpeg is built with for Windows" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev make nasm pkgconf xz-utils \
 && rm -rf /var/lib/apt/lists/*
# Bump both together; the sum is the one GitHub lists for the release's file.
ARG LLVM_MINGW_VERSION=20261104
ARG LLVM_MINGW_SHA256=919380403de87dca3c581c2053230cd298af5e891286628ba0613b7fed370926
RUN set -eu; \
    echo "jukecord: llvm-mingw ${LLVM_MINGW_VERSION}"; \
    curl -fsSL --retry 3 -o /tmp/llvm-mingw.tar.xz \
      "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_MINGW_VERSION}/llvm-mingw-${LLVM_MINGW_VERSION}-ucrt-ubuntu-22.04-x86_64.tar.xz"; \
    echo "${LLVM_MINGW_SHA256}  /tmp/llvm-mingw.tar.xz" | sha256sum -c -; \
    mkdir /opt/llvm-mingw; \
    tar -xJf /tmp/llvm-mingw.tar.xz -C /opt/llvm-mingw --strip-components=1; \
    rm /tmp/llvm-mingw.tar.xz
ENV PATH=/opt/llvm-mingw/bin:$PATH
COPY --chmod=0755 ffmpeg.sh /usr/local/bin/jukecord-ffmpeg.sh
ARG TARGET
ARG FFMPEG_VERSION
ARG FFMPEG_SHA256
RUN echo "jukecord: FFmpeg ${FFMPEG_VERSION} for ${TARGET}" \
 && jukecord-ffmpeg.sh "$TARGET" /out

# ---- what --output takes: the files alone ---------------------------------------------------------------------------
FROM scratch AS linux
COPY --from=jukecord-ffmpeg-linux /out /

FROM scratch AS windows
COPY --from=jukecord-ffmpeg-windows /out /
