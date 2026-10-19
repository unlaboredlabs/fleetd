#!/bin/sh
# fleetd installer: curl -fsSL https://fleetd.sh | sh
#
#   sh -s -- [--no-app] [--app] [--no-init] [--uninstall]
#
# Installs the fleetd CLI to ~/.fleetd/bin/fleetd (symlinked from ~/.local/bin/fleetd) and the desktop app to
# ~/Applications/fleetd.app on macOS, or an AppImage in ~/.local/share/fleetd/app on Linux (only with a display, or
# --app); the app then updates itself. It replaces the earlier GPUI app in the same place; the new app takes over its
# hub key when it first opens. Every download is checked against the release's SHA256SUMS. Safe to run again; it
# replaces what it installed.
# With a terminal it then runs `fleetd init` (the setup wizard) on it; --no-init, or no terminal, only installs.
#
# FLEETD_CHANNEL=nightly|stable picks the release (default nightly). FLEETD_BASE_URL points at another directory
# of release assets.
#
# Everything runs from main at the end, so a partly downloaded script does nothing.
set -eu

REPO="unlaboredlabs/fleetd"

say() { printf '%s\n' "fleetd: $*"; }
warn() { printf '%s\n' "fleetd: $*" >&2; }
die() {
  warn "$*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://fleetd.sh | sh -s -- [options]

  --no-app      install only the CLI
  --app         install the desktop app on Linux even without a display
  --no-init     don't start the setup wizard (fleetd init) after installing
  --uninstall   remove the CLI and the app (fleetd's data in ~/.fleetd stays)

Environment: FLEETD_CHANNEL=nightly|stable (default nightly), FLEETD_BASE_URL=<asset directory>
EOF
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "need sha256sum or shasum to verify downloads"
  fi
}

# fetch <asset> <dest>: download one release asset and check it against SHA256SUMS.
fetch() {
  expected="$(awk -v n="$1" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || return 1
  curl -fsSL --retry 3 -o "$2" "$base/$1" || die "download failed: $base/$1"
  actual="$(sha256 "$2")"
  [ "$actual" = "$expected" ] || {
    rm -f "$2"
    die "checksum mismatch for $1 (expected $expected, got $actual); not installing"
  }
}

# swap <new> <dest>: put a new file or directory in place by renaming, never by writing into the old one. A running
# binary keeps its old inode; macOS kills a process whose signed binary is overwritten in place.
swap() {
  if [ -d "$2" ] && [ ! -L "$2" ]; then
    rm -rf "$2.old"
    mv "$2" "$2.old"
    mv "$1" "$2"
    rm -rf "$2.old"
  else
    mv -f "$1" "$2"
  fi
}

install_cli() {
  asset="fleetd-$os-$arch"
  mkdir -p "$bin_dir"
  if ! fetch "$asset" "$bin_dir/.fleetd.new"; then
    rm -f "$bin_dir/.fleetd.new"
    warn "no CLI for $os-$arch on the $channel channel yet; skipping it"
    return 0
  fi
  chmod 755 "$bin_dir/.fleetd.new"
  swap "$bin_dir/.fleetd.new" "$bin_dir/fleetd"
  mkdir -p "$HOME/.local/bin"
  link="$HOME/.local/bin/fleetd"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    warn "$link exists and is not ours; leaving it (fleetd is at $bin_dir/fleetd)"
  else
    ln -sfn "$bin_dir/fleetd" "$link"
  fi
  say "installed the CLI: $bin_dir/fleetd"
  installed=1
}

install_app_macos() {
  if ! fetch fleetd-desktop-macos-universal.zip "$tmp/app.zip"; then
    warn "no desktop app on the $channel channel yet; skipping it"
    return 0
  fi
  mkdir -p "$tmp/app" "$HOME/Applications"
  ditto -x -k "$tmp/app.zip" "$tmp/app"
  [ -d "$tmp/app/fleetd.app" ] || die "the app archive has no fleetd.app"
  rm -rf "$HOME/Applications/.fleetd.app.new"
  mv "$tmp/app/fleetd.app" "$HOME/Applications/.fleetd.app.new"
  gpui=0
  [ -e "$HOME/Applications/fleetd.app/Contents/MacOS/fleetd-app" ] && gpui=1
  swap "$HOME/Applications/.fleetd.app.new" "$HOME/Applications/fleetd.app"
  say "installed the app: ~/Applications/fleetd.app"
  [ "$gpui" = 0 ] || replaced_gpui
  installed=1
}

# The GPUI app had the same bundle id and place; a copy of it still open keeps running until it quits.
replaced_gpui() {
  say "it replaces the previous fleetd app: quit that one if it is open. The new app keeps its pairing."
}

install_app_linux() {
  if ! fetch fleetd-desktop-linux-x86_64.AppImage "$tmp/fleetd-desktop.AppImage"; then
    warn "no desktop app for linux-$arch on the $channel channel yet; skipping it"
    return 0
  fi
  mkdir -p "$app_dir_parent" "$apps_dir"
  rm -rf "$app_dir.new"
  mkdir -p "$app_dir.new"
  gpui=0
  [ -e "$app_dir/fleetd-app" ] && gpui=1
  # The app updates this file in place, under the same name.
  mv "$tmp/fleetd-desktop.AppImage" "$app_dir.new/fleetd-desktop.AppImage"
  chmod 755 "$app_dir.new/fleetd-desktop.AppImage"
  # Best effort: without it the menu entry gets a generic icon. Extracting needs no FUSE.
  if (cd "$tmp" && "$app_dir.new/fleetd-desktop.AppImage" --appimage-extract fleetd-desktop.png >/dev/null 2>&1); then
    mv "$tmp/squashfs-root/fleetd-desktop.png" "$app_dir.new/fleetd.png" 2>/dev/null || true
  fi
  swap "$app_dir.new" "$app_dir"
  # Named after the app's Wayland app_id / WM_CLASS (desktopName in app/desktop/package.json), so its windows get
  # this entry's name and icon. %u hands a fleetd:// pairing link to the app.
  cat >"$apps_dir/.fleetd-desktop.desktop.new" <<DESKTOP
[Desktop Entry]
Type=Application
Name=fleetd
Comment=Watch and steer your software factory
Exec=$app_dir/fleetd-desktop.AppImage %u
Icon=$app_dir/fleetd.png
Terminal=false
Categories=Development;
StartupWMClass=fleetd-desktop
MimeType=x-scheme-handler/fleetd;
DESKTOP
  mv "$apps_dir/.fleetd-desktop.desktop.new" "$apps_dir/fleetd-desktop.desktop"
  rm -f "$apps_dir/fleetd.desktop"
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default fleetd-desktop.desktop x-scheme-handler/fleetd 2>/dev/null || true
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps_dir" 2>/dev/null || true
  fi
  say "installed the app: $app_dir/fleetd-desktop.AppImage (menu entry: $apps_dir/fleetd-desktop.desktop)"
  [ "$gpui" = 0 ] || replaced_gpui
  installed=1
}

uninstall() {
  if [ -x "$bin_dir/fleetd" ]; then
    # Stops and removes the services `fleetd init` created; keeps their data.
    "$bin_dir/fleetd" uninstall || warn "fleetd uninstall failed; remove its services by hand if any are left"
  fi
  rm -rf "$bin_dir"
  link="$HOME/.local/bin/fleetd"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$bin_dir/fleetd" ]; then rm -f "$link"; fi
  # fleetd.desktop is the GPUI app's menu entry.
  rm -rf "$HOME/Applications/fleetd.app" "$app_dir" "$apps_dir/fleetd.desktop" "$apps_dir/fleetd-desktop.desktop"
  rmdir "$app_dir_parent" 2>/dev/null || true
  say "removed the fleetd CLI and app. Your data in ~/.fleetd is still there; delete it yourself if you want it gone."
}

main() {
  want_app=auto
  do_uninstall=0
  run_init=1
  for arg in "$@"; do
    case "$arg" in
      --no-app) want_app=no ;;
      --app) want_app=yes ;;
      --uninstall) do_uninstall=1 ;;
      --no-init) run_init=0 ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage >&2
        die "unknown option: $arg"
        ;;
    esac
  done

  [ -n "${HOME:-}" ] || die "HOME is not set"
  bin_dir="$HOME/.fleetd/bin"
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  app_dir_parent="$data_home/fleetd"
  app_dir="$app_dir_parent/app"
  apps_dir="$data_home/applications"

  if [ "$do_uninstall" = 1 ]; then
    uninstall
    return 0
  fi

  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported OS: $(uname -s) (fleetd runs on macOS and Linux)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  # An Intel shell under Rosetta on Apple silicon still gets the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi

  channel="${FLEETD_CHANNEL:-nightly}"
  case "$channel" in
    nightly) default_base="https://github.com/$REPO/releases/download/nightly" ;;
    stable | latest) default_base="https://github.com/$REPO/releases/latest/download" ;;
    *) die "FLEETD_CHANNEL must be nightly or stable, not $channel" ;;
  esac
  base="${FLEETD_BASE_URL:-$default_base}"

  command -v curl >/dev/null 2>&1 || die "need curl"
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t fleetd)"
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' INT TERM
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
    die "could not download $base/SHA256SUMS (is there a $channel release yet?)"

  # The install_* functions set installed=1. They are never called as an `if` condition, where `set -e` is off.
  installed=0
  install_cli
  if [ "$want_app" = auto ]; then
    if [ "$os" = darwin ] || [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then want_app=yes; else want_app=no; fi
  fi
  if [ "$want_app" = yes ]; then
    if [ "$os" = linux ] && [ "$arch" != x64 ]; then
      warn "no desktop app for linux-$arch yet; skipping it"
    elif [ "$os" = darwin ]; then
      install_app_macos
    else
      install_app_linux
    fi
  fi
  [ "$installed" = 1 ] || die "nothing to install from $base"

  [ -x "$bin_dir/fleetd" ] || return 0
  # `curl | sh` has the script on stdin, so the wizard reads the terminal itself. Without one (CI, a pipe), or with
  # --no-init, only the next command is printed. The binary is in place either way; Ctrl-C in the wizard leaves it.
  if [ "$run_init" = 1 ] && [ -t 2 ] && (: </dev/tty) 2>/dev/null; then
    status=0
    "$bin_dir/fleetd" init </dev/tty || status=$?
    return "$status"
  fi
  # shellcheck disable=SC2088 # the tilde is printed for the user to type
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) next="fleetd init" ;;
    *) next="~/.local/bin/fleetd init" ;;
  esac
  printf '\nNext, run:\n  %s\n' "$next"
}

main "$@"
