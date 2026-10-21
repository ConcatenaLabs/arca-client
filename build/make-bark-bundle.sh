#!/usr/bin/env bash
# Builds Bark's client, `bark`, and its daemon, `barkd`, from the upstream
# release pinned in build/BARK_COMMIT, with one patch, build/bark-testnet4.patch,
# and stages them for the app to carry beside `arca`; on Linux also Bark's
# server, `captaind`, and its watchman, `watchmand`, which the Deploy screen
# runs for a Bitcoin ark:
#
#   build/bark-linux-x64/          (TARGET=x86_64-unknown-linux-gnu, the default)
#   build/bark-win-x64/            (TARGET=x86_64-pc-windows-msvc, on Windows)
#     bin/bark[.exe] bin/barkd[.exe]   stripped
#     bin/captaind bin/watchmand       Bark's server and watchman (Linux only)
#     VERSION          the Bark commit, the patch's SHA-256, the target, the compiler
#     LICENSE          Bark's license
#
# The Bitcoin side of the app is Bark as upstream ships it, so the app can join
# any Bark ark. The patch adds the network the Sequentia testnet anchors to,
# testnet4, which upstream's client does not list, and makes a testnet4 wallet
# accept the BOLT11 invoices of its network (their "tb" currency is shared with
# testnet3). Nothing else is changed.
#
# `arca bitcoin create` runs `barkd` once, for as long as the create takes, so
# the wallet's mnemonic reaches Bark in a request body rather than on a
# command line other users of the machine can read.
#
# Build paths are mapped away (--remap-path-prefix), so the binaries name no
# directory of the machine that built them; the script checks that they do not.
#
# Environment:
#   BARK_SRC          a clone of Bark to build in (default build/cache/bark,
#                     cloned from BARK_REPO when missing). Its working tree is
#                     checked out at the pinned commit with the patch applied,
#                     so it must be clean, or hold exactly that patch.
#   BARK_REPO         where to clone it from (default Bark's upstream on GitLab).
#   TARGET            the Rust target (default x86_64-unknown-linux-gnu).
#   CARGO_TARGET_DIR  where cargo builds (default <BARK_SRC>/target).
#   CARGO_BUILD_JOBS  parallel jobs (default 4).
#   PROTOC            protoc, which Bark's crates need to build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIN="$(tr -d '[:space:]' < "$HERE/BARK_COMMIT")"
PATCH="$HERE/bark-testnet4.patch"
PATCH_SHA256=1c253c40010751528903e1b3f318d00df86715721803cbd29e8e42e43bbea689
BARK_SRC="${BARK_SRC:-$HERE/cache/bark}"
BARK_REPO="${BARK_REPO:-https://gitlab.com/ark-bitcoin/bark.git}"
TARGET="${TARGET:-x86_64-unknown-linux-gnu}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
case "$TARGET" in
  x86_64-unknown-linux-gnu) OUT="$HERE/bark-linux-x64"; X=; SERVER="captaind watchmand" ;;
  x86_64-pc-windows-gnu|x86_64-pc-windows-msvc) OUT="$HERE/bark-win-x64"; X=.exe; SERVER= ;;
  *) echo "unsupported TARGET $TARGET" >&2; exit 1 ;;
esac

sha_of() { local x; x=$(sha256sum "$1"); printf '%s\n' "${x%% *}"; }
[ "$(sha_of "$PATCH")" = "$PATCH_SHA256" ] || { echo "$PATCH is not the patch this script pins" >&2; exit 1; }

echo "=== Bark at $PIN, with the testnet4 patch ==="
if [ ! -e "$BARK_SRC/.git" ]; then
  if [ -e "$BARK_SRC" ] && [ -n "$(ls -A "$BARK_SRC")" ]; then
    echo "$BARK_SRC exists and is not a clone of Bark: move it away, or name a clone with BARK_SRC" >&2; exit 1
  fi
  mkdir -p "$(dirname "$BARK_SRC")"
  git clone --quiet "$BARK_REPO" "$BARK_SRC"
fi
if ! git -C "$BARK_SRC" cat-file -e "$PIN^{commit}" 2>/dev/null; then git -C "$BARK_SRC" fetch --quiet "$BARK_REPO"; fi
if [ "$(git -C "$BARK_SRC" rev-parse HEAD)" = "$PIN" ] && git -C "$BARK_SRC" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "the patch is applied already"
else
  if [ -n "$(git -C "$BARK_SRC" status --porcelain --untracked-files=no)" ]; then
    echo "$BARK_SRC has changes other than the patch; the bundle is built from the pinned release and the patch only" >&2; exit 1
  fi
  git -C "$BARK_SRC" -c advice.detachedHead=false checkout --quiet --detach "$PIN"
  git -C "$BARK_SRC" apply "$PATCH"
fi
FULL="$(git -C "$BARK_SRC" rev-parse HEAD)"
[ "$FULL" = "$PIN" ] || { echo "checked out $FULL, not $PIN" >&2; exit 1; }
git -C "$BARK_SRC" diff --stat | tail -1

echo "=== build ($TARGET) ==="
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
REMAP="--remap-path-prefix=$BARK_SRC=/bark --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"
if [ -n "${CARGO_TARGET_DIR:-}" ]; then REMAP="$REMAP --remap-path-prefix=$CARGO_TARGET_DIR=/target"; fi
export RUSTFLAGS="${RUSTFLAGS:-} $REMAP"
export CARGO_PROFILE_RELEASE_STRIP=symbols CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_INCREMENTAL=0
( cd "$BARK_SRC" && cargo build --release --locked --target "$TARGET" -p bark-cli --bin bark --bin barkd )
if [ -n "$SERVER" ]; then
  ( cd "$BARK_SRC" && cargo build --release --locked --target "$TARGET" -p bark-server --bin captaind --bin watchmand )
fi
TDIR="${CARGO_TARGET_DIR:-$BARK_SRC/target}"

echo "=== stage $OUT ==="
rm -rf "$OUT"
mkdir -p "$OUT/bin"
for b in bark barkd $SERVER; do cp "$TDIR/$TARGET/release/$b$X" "$OUT/bin/$b$X"; done
cp "$BARK_SRC/LICENSE" "$OUT/LICENSE"
printf 'bark %s\npatch bark-testnet4.patch sha256 %s\ntarget %s\n%s\n' "$FULL" "$PATCH_SHA256" "$TARGET" "$(rustc --version)" > "$OUT/VERSION"

echo "=== check: no build path in the binaries ==="
bad=0
for b in bark barkd $SERVER; do
  for p in "$BARK_SRC" "$HOME" "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" ${CARGO_TARGET_DIR:+"$CARGO_TARGET_DIR"}; do
    n="$(grep -a -c -F -- "$p" "$OUT/bin/$b$X" || true)"
    if [ "$n" != 0 ]; then echo "$b holds $p ($n lines)" >&2; bad=1; fi
  done
done
[ "$bad" = 0 ]
if [ -z "$X" ]; then
  "$OUT/bin/bark" --version
  "$OUT/bin/bark" create --help | grep -q -- '--testnet4' || { echo "this bark has no --testnet4" >&2; exit 1; }
  "$OUT/bin/barkd" --help > /dev/null
  "$OUT/bin/captaind" --version
  "$OUT/bin/watchmand" --help > /dev/null
fi
ls -l "$OUT/bin"
cat "$OUT/VERSION"
echo "STAGED OK -> $OUT"
