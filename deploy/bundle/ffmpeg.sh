#!/bin/sh
# FFmpeg for one of the release's programs (deploy/bundle/README.md): the same FFmpeg as the image's (the configure line
# of deploy/docker/Dockerfile: audio only, every demuxer, decoder and protocol of FFmpeg's own, Opus and MP3 out), as
# one program that needs nothing installed beside it. The libraries it is built with are built here from their release
# sources and linked in; TLS for https is the system's own where it has one (Schannel on Windows, Secure Transport on
# macOS) and OpenSSL on Linux, where the program is static against musl and so runs on any distribution.
#
#   FFMPEG_VERSION=7.1.5 FFMPEG_SHA256=... deploy/bundle/ffmpeg.sh <target> <folder>
#
# <target> is linux-x64 or linux-arm64 (on Alpine, as deploy/bundle/Dockerfile runs it), windows-x64 or windows-arm64
# (with llvm-mingw, the same), or macos-arm64 or macos-x64 (on a Mac of that processor, with Xcode's compiler,
# pkg-config and, on Intel, nasm). deploy/bundle/build-ffmpeg.sh runs it, with FFmpeg's release and SHA-256 read from
# the image's Dockerfile. The folder gets the program, its licence, the licences of the libraries in it and SOURCE,
# which says where every part's source is.
set -eu

target=${1:?the target: linux-x64, linux-arm64, windows-x64, windows-arm64, macos-arm64 or macos-x64}
out=${2:?the folder to put FFmpeg in}
# A whole path: the build below works in the sources' own folders, where a relative one would point elsewhere.
mkdir -p "$out"
out=$(cd "$out" && pwd)
: "${FFMPEG_VERSION:?FFMPEG_VERSION, as deploy/docker/Dockerfile pins it}"
: "${FFMPEG_SHA256:?FFMPEG_SHA256, as deploy/docker/Dockerfile pins it}"

# The libraries, at the releases of the image's (Debian 13's packages of them, OpenSSL at the newest of the same 3.5
# line), each checked against the SHA-256 its own project publishes: zlib's and OpenSSL's beside their release files,
# Opus's in SHA256SUMS.txt beside it, LAME's in Debian's source package, whose copy of the release is the one fetched.
OPENSSL_VERSION=3.5.9
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
OPENSSL_URL=https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz
ZLIB_VERSION=1.3.1
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
ZLIB_URL=https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz
OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
OPUS_URL=https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz
LAME_VERSION=3.100
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
LAME_URL=https://deb.debian.org/debian/pool/main/l/lame/lame_$LAME_VERSION.orig.tar.gz
FFMPEG_URL=https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz

# What differs by system: the compiler's prefix when it builds for another system (host), FFmpeg's TLS and the flags
# that make its program stand alone.
host=
exe=ffmpeg
case $target in
  linux-x64 | linux-arm64)
    tls=--enable-openssl
    # Static against musl: no C library, OpenSSL or anything else to find on the machine it runs on.
    standalone=--extra-ldexeflags=-static
    ;;
  windows-x64 | windows-arm64)
    host=$([ "$target" = windows-x64 ] && echo x86_64-w64-mingw32 || echo aarch64-w64-mingw32)
    exe=ffmpeg.exe
    tls=--enable-schannel
    # The C runtime is Windows' own (the Universal CRT of Windows 10 and later); the compiler's parts go in the program.
    standalone=--extra-ldexeflags=-static
    ;;
  macos-arm64 | macos-x64)
    # Built for the processor of the Mac it runs on, which must be the target's.
    want=$([ "$target" = macos-arm64 ] && echo arm64 || echo x86_64)
    if [ "$(uname -m)" != "$want" ]; then
      echo "ffmpeg.sh: $target is built on a Mac with that processor ($want); this one is $(uname -m)" >&2
      exit 2
    fi
    tls=--enable-securetransport
    # The oldest macOS the release's Node runs on (Node.js 26: 13.5), for the libraries and the program alike.
    export MACOSX_DEPLOYMENT_TARGET=13.5
    # Only system libraries and frameworks are linked dynamically, and every Mac has those.
    standalone=
    ;;
  *)
    echo "ffmpeg.sh: no such target: $target" >&2
    exit 2
    ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Where the libraries are installed for FFmpeg to find, and nothing else is.
prefix=$work/prefix
mkdir -p "$prefix/include" "$prefix/lib/pkgconfig"
jobs=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

# A release's archive, checked against its SHA-256, unpacked into a folder of its own.
fetch() {
  curl -fsSL --retry 3 -o "$work/archive" "$1"
  # sha256sum on Linux, shasum on a Mac, which has no sha256sum before macOS 14.
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$2  $work/archive" | sha256sum -c - >/dev/null
  else
    echo "$2  $work/archive" | shasum -a 256 -c - >/dev/null
  fi
  mkdir -p "$3"
  tar -xf "$work/archive" -C "$3" --strip-components=1
  rm "$work/archive"
}

# The configure flag that builds for the target system, for the libraries' configure scripts.
cross=${host:+--host=$host}

echo "== zlib $ZLIB_VERSION"
fetch "$ZLIB_URL" "$ZLIB_SHA256" "$work/zlib"
cd "$work/zlib"
if [ -n "$host" ]; then
  # zlib's configure does not build for Windows; its own makefile for MinGW does.
  make -f win32/Makefile.gcc PREFIX="$host-" -j"$jobs" libz.a >/dev/null
  cp libz.a "$prefix/lib/"
  cp zlib.h zconf.h "$prefix/include/"
else
  ./configure --prefix="$prefix" --static >/dev/null
  make -j"$jobs" >/dev/null
  make install >/dev/null
fi

case $target in
  linux-*)
    echo "== OpenSSL $OPENSSL_VERSION"
    fetch "$OPENSSL_URL" "$OPENSSL_SHA256" "$work/openssl"
    cd "$work/openssl"
    # The libraries alone. Their own folder for settings and certificates, which does not exist: OpenSSL then reads no
    # openssl.cnf of the machine it runs on, whose providers (a FIPS module, say) a static copy could not load, and
    # FFmpeg checks no certificates unless told to (tls_verify), which jukecord does not.
    ./config --prefix="$prefix" --libdir=lib --openssldir=/nonexistent/jukecord-ffmpeg \
      no-shared no-tests no-docs >/dev/null
    make -j"$jobs" build_libs >/dev/null
    make install_dev >/dev/null
    ;;
esac

echo "== Opus $OPUS_VERSION"
fetch "$OPUS_URL" "$OPUS_SHA256" "$work/opus"
cd "$work/opus"
# Opus picks its Arm code by asking the processor while it runs, which it cannot do on Windows on Arm with this
# compiler; every 64-bit Arm processor has NEON, so there it uses NEON without asking.
rtcd=
if [ "$target" = windows-arm64 ]; then rtcd=--disable-rtcd; fi
# shellcheck disable=SC2086 # $cross and $rtcd are one flag or none
./configure --prefix="$prefix" $cross $rtcd --disable-shared --enable-static --disable-doc --disable-extra-programs >/dev/null
make -j"$jobs" >/dev/null
make install >/dev/null

echo "== LAME $LAME_VERSION"
fetch "$LAME_URL" "$LAME_SHA256" "$work/lame"
cd "$work/lame"
# LAME's release is from 2017, older than the arm64 Macs and Windows on Arm: its configure takes the system names from
# the newer copies of the same two files that Opus's release carries.
cp "$work/opus/config.guess" "$work/opus/config.sub" .
# The library only: no lame program, and no test of GTK.
# shellcheck disable=SC2086
./configure --prefix="$prefix" $cross --disable-shared --enable-static --disable-frontend --disable-gtktest >/dev/null
make -j"$jobs" >/dev/null
make install >/dev/null

echo "== FFmpeg $FFMPEG_VERSION for $target"
fetch "$FFMPEG_URL" "$FFMPEG_SHA256" "$work/ffmpeg"
cd "$work/ffmpeg"
crossflags=
if [ -n "$host" ]; then
  arch=$([ "$target" = windows-x64 ] && echo x86_64 || echo aarch64)
  crossflags="--enable-cross-compile --target-os=mingw32 --arch=$arch --cross-prefix=$host- --pkg-config=pkg-config"
fi
# The image's configure line (deploy/docker/Dockerfile) and, after it, what this build adds: the system's TLS, the
# libraries from the folder above (pkg-config looks there only: Opus and OpenSSL are found through it), and the flags
# that make the program stand alone.
# shellcheck disable=SC2086 # $crossflags and $standalone are several flags or none
if ! PKG_CONFIG_PATH='' PKG_CONFIG_LIBDIR=$prefix/lib/pkgconfig ./configure --prefix="$work/install" \
  --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
  --disable-autodetect --disable-avdevice --disable-swscale --disable-postproc \
  --disable-encoders --enable-encoder=libopus,libmp3lame,pcm_s16le,pcm_f32le \
  --enable-version3 --enable-zlib --enable-libopus --enable-libmp3lame \
  $tls --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" \
  $crossflags $standalone >"$work/configure.log" 2>&1; then
  # configure says what it missed, and its log what it tried.
  tail -n 5 "$work/configure.log" >&2
  tail -n 40 ffbuild/config.log >&2
  exit 1
fi
# The summary configure prints: threads on, and the TLS asked for, or the build stops here.
grep -E '^(threading support|External libraries:|Enabled protocols:)' -A2 "$work/configure.log" || true
if grep -q '^threading support *no' "$work/configure.log"; then
  echo "ffmpeg.sh: FFmpeg would be built without threads" >&2
  exit 1
fi
make -j"$jobs" >/dev/null

mkdir -p "$out/licenses"
# make leaves the program stripped of its symbols as ffmpeg (ffmpeg_g keeps them).
cp "$exe" "$out/$exe"
chmod 0755 "$out/$exe"
# The LGPL's version 3 is a set of permissions added to the GPL's, so its text comes with it.
cp LICENSE.md COPYING.LGPLv3 COPYING.GPLv3 "$out/"
cp "$work/zlib/LICENSE" "$out/licenses/zlib-LICENSE"
cp "$work/opus/COPYING" "$out/licenses/opus-COPYING"
cp "$work/lame/COPYING" "$out/licenses/lame-COPYING"
case $target in linux-*) cp "$work/openssl/LICENSE.txt" "$out/licenses/openssl-LICENSE.txt" ;; esac
{
  echo "FFmpeg $FFMPEG_VERSION, built for jukecord's $target program from $FFMPEG_URL (sha256 $FFMPEG_SHA256),"
  echo "LGPL-3.0-or-later, with no GPL parts. Built with, and holding:"
  case $target in
    linux-*) echo "  OpenSSL $OPENSSL_VERSION from $OPENSSL_URL (sha256 $OPENSSL_SHA256), Apache-2.0" ;;
  esac
  echo "  zlib $ZLIB_VERSION from $ZLIB_URL (sha256 $ZLIB_SHA256), Zlib"
  echo "  Opus $OPUS_VERSION from $OPUS_URL (sha256 $OPUS_SHA256), BSD-3-Clause"
  echo "  LAME $LAME_VERSION from $LAME_URL (sha256 $LAME_SHA256), LGPL-2.0-or-later"
  echo "Built by deploy/bundle/ffmpeg.sh of https://github.com/kanggu12/jukecord, with this configure line:"
  # As FFmpeg records it (the program prints it with -buildconf).
  sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/  \1/p' config.h
} >"$out/SOURCE"

# What jukecord asks of it, where the program runs here (not a Windows one, which the release's check runs on Windows).
case $target in
  windows-*) ;;
  *)
    "$out/$exe" -hide_banner -encoders | grep -q libopus
    "$out/$exe" -hide_banner -encoders | grep -q libmp3lame
    "$out/$exe" -hide_banner -protocols | grep -qx '  https'
    ;;
esac
ls -l "$out/$exe"
