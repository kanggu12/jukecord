#!/bin/sh
# FFmpeg for one of the release's programs, into a folder: in Docker (the Dockerfile beside this file) for Linux and
# Windows, by ffmpeg.sh itself on a Mac. FFmpeg's release and SHA-256 are read from the image's Dockerfile, so the
# programs and the image carry the same FFmpeg.
#
#   deploy/bundle/build-ffmpeg.sh <target> <folder>      linux-x64, linux-arm64, windows-x64, windows-arm64,
#                                                         macos-arm64 or macos-x64
#
# Linux on arm64 builds natively on an arm64 machine and through emulation elsewhere (much slower); Windows builds on
# any x86-64 machine with Docker; macOS builds only on a Mac of that processor.
set -eu
target=${1:?the target: linux-x64, linux-arm64, windows-x64, windows-arm64, macos-arm64 or macos-x64}
out=${2:?the folder to put FFmpeg in}
here=$(cd "$(dirname "$0")" && pwd)
dockerfile=$here/../docker/Dockerfile
FFMPEG_VERSION=$(sed -n 's/^ARG FFMPEG_VERSION=//p' "$dockerfile")
FFMPEG_SHA256=$(sed -n 's/^ARG FFMPEG_SHA256=//p' "$dockerfile")
test -n "$FFMPEG_VERSION" && test -n "$FFMPEG_SHA256"
export FFMPEG_VERSION FFMPEG_SHA256
case $target in
  linux-x64) stage=linux platform=linux/amd64 ;;
  linux-arm64) stage=linux platform=linux/arm64 ;;
  windows-x64 | windows-arm64) stage=windows platform=linux/amd64 ;;
  macos-arm64 | macos-x64) exec "$here/ffmpeg.sh" "$target" "$out" ;;
  *)
    echo "build-ffmpeg.sh: no such target: $target" >&2
    exit 2
    ;;
esac
# --build-arg NAME without a value takes it from the environment above.
docker buildx build --target "$stage" --platform "$platform" \
  --build-arg TARGET="$target" --build-arg FFMPEG_VERSION --build-arg FFMPEG_SHA256 \
  --output "type=local,dest=$out" "$here"
