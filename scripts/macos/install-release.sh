#!/bin/bash
set -euo pipefail

RELEASE_BASE_URL="${PIXEL_CREW_RELEASE_BASE_URL:-https://github.com/juinwei7/Pixel-Crew/releases/latest/download}"
INSTALL_ROOT="${PIXEL_CREW_INSTALL_ROOT:-$HOME/Applications}"
APP_PATH="$INSTALL_ROOT/Pixel Crew.app"
SKIP_LAUNCH="${PIXEL_CREW_SKIP_LAUNCH:-0}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Pixel Crew installer: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -d "$APP_PATH" ]]; then
    if [[ "$SKIP_LAUNCH" != "1" ]] && command -v osascript >/dev/null 2>&1; then
      osascript -e 'tell application id "com.juinwei7.pixelcrew" to quit' >/dev/null 2>&1 || true
    fi
    rm -rf -- "$APP_PATH"
    say "Removed $APP_PATH"
  else
    say "Pixel Crew is not installed at $APP_PATH"
  fi
  say "Local data was preserved in ~/Library/Application Support/Pixel Crew"
  exit 0
fi

machine="${PIXEL_CREW_ARCH_OVERRIDE:-$(uname -m)}"
case "$machine" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *) fail "unsupported Mac architecture: $machine" ;;
esac

archive="pixel-crew-macos-$arch.tar.gz"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/pixel-crew-install.XXXXXX")"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

say "Downloading Pixel Crew for $arch..."
curl -fsSL "$RELEASE_BASE_URL/$archive" -o "$temporary/$archive"
curl -fsSL "$RELEASE_BASE_URL/SHA256SUMS.txt" -o "$temporary/SHA256SUMS.txt"

checksum_line="$(awk -v name="$archive" '$2 == name { count++; line=$0 } END { if (count != 1) exit 1; print line }' "$temporary/SHA256SUMS.txt")" ||
  fail "SHA256SUMS.txt does not contain $archive"
cd "$temporary"
if command -v shasum >/dev/null 2>&1; then
  printf '%s\n' "$checksum_line" | shasum -a 256 -c -
elif command -v sha256sum >/dev/null 2>&1; then
  printf '%s\n' "$checksum_line" | sha256sum -c -
else
  fail "no SHA-256 verification tool is available"
fi

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  fail "release archive contains an unsafe path"
fi
mkdir "$temporary/extracted"
tar -xzf "$archive" -C "$temporary/extracted"
source_app="$temporary/extracted/Pixel Crew.app"
[[ -x "$source_app/Contents/MacOS/Pixel Crew" ]] || fail "release is missing the Pixel Crew launcher"
[[ -x "$source_app/Contents/Resources/runtime/bin/node" ]] || fail "release is missing its Node runtime"
[[ -f "$source_app/Contents/Resources/app/server/dist/index.js" ]] || fail "release is missing its server"
[[ -f "$source_app/Contents/Resources/app/web/dist/index.html" ]] || fail "release is missing its web app"

mkdir -p "$INSTALL_ROOT"
stage="$INSTALL_ROOT/.Pixel Crew.app.install.$$"
backup="$INSTALL_ROOT/.Pixel Crew.app.previous.$$"
rm -rf -- "$stage" "$backup"
cp -R "$source_app" "$stage"
if [[ -e "$APP_PATH" ]]; then mv "$APP_PATH" "$backup"; fi
if mv "$stage" "$APP_PATH"; then
  rm -rf -- "$backup"
else
  [[ ! -e "$APP_PATH" && -e "$backup" ]] && mv "$backup" "$APP_PATH"
  fail "unable to replace the existing Pixel Crew app"
fi

say "Installed Pixel Crew at $APP_PATH"
say "This certificate-free build was verified with the release SHA-256 checksum."
if [[ "$SKIP_LAUNCH" != "1" ]]; then
  open "$APP_PATH"
fi
