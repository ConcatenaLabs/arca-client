#!/usr/bin/env bash
# Builds the Arca command-line client, `arca`, from ConcatenaLabs/arca at the
# commit pinned in build/ARCA_COMMIT, and stages it for the app to carry:
#
#   build/arca-linux-x64/          (TARGET=x86_64-unknown-linux-gnu, the default)
#   build/arca-win-x64/            (TARGET=x86_64-pc-windows-gnu, or -msvc on Windows)
#     bin/arca[.exe]   the client, stripped
#     VERSION          the arca commit, the target and the compiler
#     LICENSE          arca's license
#
# Build paths are mapped away (--remap-path-prefix), so the binary names no
# directory of the machine that built it; the script checks that it does not.
#
# Environment:
#   ARCA_SRC          a clone of ConcatenaLabs/arca to build in (default:
#                     build/cache/arca, cloned when missing). Its working tree
#                     is checked out at the pinned commit, so it must be clean.
#   TARGET            the Rust target (default x86_64-unknown-linux-gnu).
#   CARGO_TARGET_DIR  where cargo builds (default <ARCA_SRC>/target).
#   CARGO_BUILD_JOBS  parallel jobs (default 4).
#   PROTOC            protoc, which Bark's crates need to build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIN="$(tr -d '[:space:]' < "$HERE/ARCA_COMMIT")"
ARCA_SRC="${ARCA_SRC:-$HERE/cache/arca}"
TARGET="${TARGET:-x86_64-unknown-linux-gnu}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
case "$TARGET" in
  x86_64-unknown-linux-gnu) OUT="$HERE/arca-linux-x64"; EXE=arca ;;
  x86_64-pc-windows-gnu|x86_64-pc-windows-msvc) OUT="$HERE/arca-win-x64"; EXE=arca.exe ;;
  *) echo "unsupported TARGET $TARGET" >&2; exit 1 ;;
esac

echo "=== arca at $PIN ==="
if [ ! -d "$ARCA_SRC/.git" ]; then
  mkdir -p "$(dirname "$ARCA_SRC")"
  git clone --quiet https://github.com/ConcatenaLabs/arca.git "$ARCA_SRC"
fi
git -C "$ARCA_SRC" fetch --quiet origin
if [ -n "$(git -C "$ARCA_SRC" status --porcelain --untracked-files=no)" ]; then
  echo "$ARCA_SRC has changes; the bundle is built from the pinned commit only" >&2; exit 1
fi
git -C "$ARCA_SRC" checkout --quiet --detach "$PIN"
FULL="$(git -C "$ARCA_SRC" rev-parse HEAD)"
case "$FULL" in "$PIN"*) ;; *) echo "checked out $FULL, not $PIN" >&2; exit 1 ;; esac

echo "=== build ($TARGET) ==="
# Every absolute path the compiler could write into the binary, mapped to a
# name that says nothing of this machine.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
REMAP="--remap-path-prefix=$ARCA_SRC=/arca --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"
if [ -n "${CARGO_TARGET_DIR:-}" ]; then REMAP="$REMAP --remap-path-prefix=$CARGO_TARGET_DIR=/target"; fi
export RUSTFLAGS="${RUSTFLAGS:-} $REMAP"
export CARGO_PROFILE_RELEASE_STRIP=symbols CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_INCREMENTAL=0
( cd "$ARCA_SRC" && cargo build --release --locked --target "$TARGET" -p arca-cli --bin arca )
TDIR="${CARGO_TARGET_DIR:-$ARCA_SRC/target}"
BIN="$TDIR/$TARGET/release/$EXE"

echo "=== stage $OUT ==="
rm -rf "$OUT"
mkdir -p "$OUT/bin"
cp "$BIN" "$OUT/bin/$EXE"
cp "$ARCA_SRC/LICENSE" "$OUT/LICENSE"
printf 'arca %s\ntarget %s\n%s\n' "$FULL" "$TARGET" "$(rustc --version)" > "$OUT/VERSION"

echo "=== check: no build path in the binary ==="
bad=0
for p in "$ARCA_SRC" "$HOME" "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" ${CARGO_TARGET_DIR:+"$CARGO_TARGET_DIR"}; do
  n="$(grep -a -c -F -- "$p" "$OUT/bin/$EXE" || true)"
  if [ "$n" != 0 ]; then echo "the binary holds $p ($n lines)" >&2; bad=1; fi
done
[ "$bad" = 0 ]
if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
  "$OUT/bin/$EXE" --help > /dev/null
  "$OUT/bin/$EXE" --help | grep -q '^  schedule' || { echo "this arca has no schedule command: pin a newer commit" >&2; exit 1; }
fi
ls -l "$OUT/bin/$EXE"
cat "$OUT/VERSION"
echo "STAGED OK -> $OUT"
