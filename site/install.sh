#!/bin/sh
# fleetd installer: curl -fsSL https://fleetd.sh | sh
#
#   sh -s -- [--no-app] [--app] [--no-init] [--uninstall]
#   FLEETD_JOIN_CODE=<code> sh -s -- --join <workspace url> [--machine-id <id>] [--git-identity "Name <email>"] [--rejoin]
#            [--mac] [--version <workspace's version>]
#
# Installs the fleetd CLI to ~/.fleetd/bin/fleetd (symlinked from ~/.local/bin/fleetd) and the desktop app to
# ~/Applications/fleetd.app on macOS, or an AppImage in ~/.local/share/fleetd/app on Linux (only with a display, or
# --app); the app then updates itself. The CLI needs macOS 13 (Bun's floor): on an older Mac the installer stops before
# changing anything. It replaces the earlier GPUI app in the same place; the new app takes over its
# workspace key when it first opens. Every download is checked against the release's checksums. Safe to run again; it
# replaces what it installed.
# With a terminal it then runs `fleetd init` (the setup wizard) on it; --no-init, or no terminal, only installs.
# With --join and a code (the command `fleetd pair --worker` prints) it runs `fleetd init --join` instead, which
# makes this machine a worker of that workspace without asking for its address or code, with or without a terminal.
# The one-time code comes in FLEETD_JOIN_CODE and goes on to fleetd in its environment, which only this user reads:
# never in a command's arguments, which any user on the machine can list (ps). --code still works, for older lines.
# --mac joins the agents' Mac (docs: agents-mac.md): run in Terminal logged in at the Mac's screen (an admin's account
# is fine), which it checks before it downloads anything; it installs no app there.
# --version (in the agents' Mac's join line) installs the workspace's own build and channel: a tagged version from its own
# release, an edge one from the edge release, which holds the workspace's build until main moves on and a newer one after;
# the workspace's Update then brings the workspace level with it. FLEETD_CHANNEL is then not read.
#
# FLEETD_CHANNEL=edge|stable picks the release (default edge, the newest build of main; nightly, its name until
# D203, is edge too). Every build goes out on edge (D701); stable, a tagged release, has none yet, and says so.
# FLEETD_BASE_URL points at another directory of release assets.
#
# Everything runs from main at the end, so a partly downloaded script does nothing.
set -eu

REPO="unlaboredlabs/fleetd"

# Output. On a terminal (stdout and stderr both one, and no NO_COLOR, TERM=dumb or CI) each step shows as it runs, with
# a spinner, or a progress bar while it downloads, and turns into a ✓ line when done, as `fleetd init`'s checklist
# does; green is the one accent, details are dim. Anywhere else each step is one plain line, with no escape codes.
ui_init() {
  rich=0
  if [ -t 1 ] && [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ -z "${CI:-}" ]; then
    case "${TERM:-dumb}" in dumb) ;; *) rich=1 ;; esac
  fi
  # live: a step's line is on the screen without its newline. job: the background command it shows. why: what it said
  # on stderr when it failed.
  live=0
  job=""
  why=""
  tick=0.1
  barw=24
  [ "$rich" = 1 ] || return 0
  sleep 0.1 2>/dev/null || tick=1
  cols="$(stty size </dev/tty 2>/dev/null | cut -d' ' -f2)"
  case "$cols" in "" | *[!0-9]*) cols=80 ;; esac
  # The bar's line is 56 columns beside it; a narrower terminal gets a shorter bar, or none, rather than a wrapped line.
  barw=$((cols - 58))
  [ "$barw" -le 24 ] || barw=24
  [ "$barw" -ge 8 ] || barw=0
}

paint() { if [ "$rich" = 1 ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }
dim() { paint 2 "$1"; }

# unlive: clear a step's line still being drawn, so what comes next starts on an empty line.
unlive() {
  [ "$live" = 1 ] || return 0
  printf '\r\033[2K'
  live=0
}

# row <mark> <title> <detail>: a step's line. The titles line up, as a column.
row() { printf '%s  %s%s' "$1" "$(paint 1 "$(printf '%-10s' "$2")")" "$(dim "$3")"; }

# draw <mark> <title> <detail>: a step while it runs, redrawn in place.
draw() {
  printf '\r\033[2K%s' "$(row "$@")"
  live=1
}

# done_step <title> <detail>: a step that's done.
done_step() {
  unlive
  printf '%s\n' "$(row "$(paint 32 ✓)" "$1" "$2")"
}

# say: a note. warn and die: on stderr, die's first line the error, then why (what a step that just failed said), then
# what to do about it.
say() {
  unlive
  if [ "$rich" = 1 ]; then printf '%s  %s\n' "$(dim │)" "$*"; else printf '%s\n' "fleetd: $*"; fi
}
warn() {
  unlive
  if [ "$rich" = 1 ]; then
    printf '%s\n' "$*" | {
      IFS= read -r first
      printf '%s  %s\n' "$(paint 33 !)" "$first"
      while IFS= read -r l; do printf '   %s\n' "$(dim "$l")"; done
    } >&2
  else
    printf '%s\n' "fleetd: $*" >&2
  fi
}
die() {
  unlive
  if [ "$rich" = 1 ]; then
    printf '%s\n' "$*" | {
      IFS= read -r first
      printf '%s  %s\n' "$(paint 31 ✗)" "$(paint 1 "$first")"
      [ -z "$why" ] || printf '%s\n' "$why" | while IFS= read -r l; do printf '   %s\n' "$(dim "$l")"; done
      while IFS= read -r l; do printf '   %s\n' "$l"; done
    } >&2
  else
    printf '%s\n' "fleetd: $*" >&2
  fi
  exit 1
}

# header <title>: the frame's top, as `fleetd init` opens its own.
header() {
  [ "$rich" = 1 ] || return 0
  printf '%s  \033[7m %s \033[0m\n%s\n' "$(dim ┌)" "$1" "$(dim │)"
}

# footer <line> [<line>]: the frame's bottom, under the steps.
footer() {
  if [ "$rich" = 1 ]; then
    printf '%s\n%s  %s\n' "$(dim │)" "$(dim └)" "$1"
    [ -z "${2:-}" ] || printf '   %s\n' "$2"
    printf '\n'
  else
    printf '\n%s\n' "$1"
    [ -z "${2:-}" ] || printf '%s\n' "$2"
  fi
}

# tilde <path>: <path> as ~/… under $HOME.
# shellcheck disable=SC2088 # the tilde is printed for the user to read
tilde() {
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# size <bytes>: 113.0 MB, 512 KB.
size() {
  if [ "$1" -ge 1000000 ]; then
    printf '%d.%d MB' $(($1 / 1000000)) $(($1 / 100000 % 10))
  elif [ "$1" -ge 1000 ]; then
    printf '%d KB' $(($1 / 1000))
  else
    printf '%d B' "$1"
  fi
}

# run_live <draw> <command>...: <command> in the background, with <draw> <spinner frame> on its line ten times a
# second until it ends; its status. Its stderr, which would draw across that line, is kept in $why when it fails, for
# die to show under the error. The cursor hides meanwhile (and comes back on exit, see main's trap).
run_live() {
  ui_draw="$1"
  shift
  printf '\033[?25l'
  "$@" 2>"$tmp/live.err" &
  job=$!
  n=0
  while kill -0 "$job" 2>/dev/null; do
    case $((n % 4)) in 0) f=◒ ;; 1) f=◐ ;; 2) f=◓ ;; *) f=◑ ;; esac
    n=$((n + 1))
    "$ui_draw" "$(paint 32 "$f")"
    sleep "$tick"
  done
  rc=0
  wait "$job" || rc=$?
  job=""
  unlive
  printf '\033[?25h'
  why=""
  [ "$rc" = 0 ] || why="$(cat "$tmp/live.err")"
  return "$rc"
}

# spin <title> <detail> <command>...: <command> as a step with a spinner on a terminal; elsewhere just <command>.
spin() {
  if [ "$rich" = 0 ]; then
    shift 2
    "$@"
    return
  fi
  spin_title="$1"
  spin_detail="$2"
  shift 2
  run_live spin_draw "$@"
}
spin_draw() { draw "$1" "$spin_title" "$spin_detail"; }

# get <curl arguments>: curl, which gives up on a connection not open within 20 s or a transfer under 1 KB/s for 30 s,
# and then tries 3 times more (curl retries a timeout), rather than wait forever on a network that dropped.
get() { curl -fsSL --connect-timeout 20 --speed-limit 1024 --speed-time 30 --retry 3 "$@"; }

# download <url> <dest> <what>: curl <url> to <dest>; on a terminal with a progress bar of the bytes on disk against
# the last Content-Length curl got (a redirect's comes first), or only the bytes when there is none.
download() {
  dl_dest="$2"
  dl_what="$3"
  dl_total=0
  dl_got=0
  if [ "$rich" = 0 ]; then
    get -o "$2" "$1" || return
  else
    rm -f "$tmp/headers" "$2"
    run_live download_draw get -D "$tmp/headers" -o "$2" "$1" || return
  fi
  [ ! -f "$2" ] || dl_got=$(($(wc -c <"$2")))
  done_step Download "$dl_what · $(size "$dl_got")"
}
download_draw() {
  [ ! -f "$dl_dest" ] || dl_got=$(($(wc -c <"$dl_dest")))
  # Until the body flows the headers can still change: a redirect's Content-Length is the redirect's own.
  if [ "$dl_got" = 0 ] || [ "$dl_total" = 0 ]; then
    dl_total="$(awk 'tolower($1) == "content-length:" { n = $2 + 0 } END { print n + 0 }' "$tmp/headers" 2>/dev/null || echo 0)"
  fi
  if [ "$dl_total" -gt 0 ] && [ "$dl_got" -le "$dl_total" ]; then
    pct=$((dl_got * 100 / dl_total))
    bar=""
    if [ "$barw" -gt 0 ]; then
      fill=$((dl_got * barw / dl_total))
      on=""
      off=""
      i=0
      # ${on}, not $on, before a non-ASCII character: macOS's sh, in a UTF-8 locale, reads ━'s first byte as part of a
      # bare name ("on?: unbound variable"). The installer test refuses a bare one.
      while [ "$i" -lt "$fill" ]; do
        on="${on}━"
        i=$((i + 1))
      done
      while [ "$i" -lt "$barw" ]; do
        off="${off}━"
        i=$((i + 1))
      done
      bar="$(paint 32 "$on")$(paint 90 "$off")  "
    fi
    printf '\r\033[2K%s  %s%s  %s%s%s' "$1" "$(paint 1 "$(printf '%-10s' Download)")" "$(dim "$dl_what")" "$bar" \
      "$(printf '%3d%%' "$pct")" "$(dim "  $(size "$dl_got") / $(size "$dl_total")")"
    live=1
  else
    draw "$1" Download "$dl_what · $(size "$dl_got")"
  fi
}

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://fleetd.sh | sh -s -- [options]

  --no-app      install only the CLI
  --app         install the desktop app on Linux even without a display
  --no-init     don't start the setup wizard (fleetd init) after installing
  --join <url> [--machine-id <id>] [--git-identity "Name <email>"] [--rejoin] [--mac]
         [--version <version>]
                join that workspace as a worker (fleetd init --join) after installing,
                its one-time code in FLEETD_JOIN_CODE (or --code <code>):
                the command fleetd pair --worker prints on the workspace's machine;
                --mac joins the agents' Mac, from Terminal logged in at its screen;
                --version installs the workspace's own build
  --uninstall   stop and remove fleetd's services on this machine, then the CLI and
                the app (fleetd's data in ~/.fleetd stays)

Environment: FLEETD_CHANNEL=edge|stable (default edge), FLEETD_BASE_URL=<asset directory>
EOF
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "need sha256sum or shasum to verify downloads
Install coreutils with this machine's package manager, then run the installer again."
  fi
}

# pinned <asset> <sha256>: the name the release keeps <asset>'s build under for good (publish.sh): the first 16 hex
# digits of its SHA-256 before its extension (.zip, .AppImage), else at its end.
pinned() {
  hex="$(printf '%s' "$2" | cut -c1-16)"
  case "$1" in
    *.zip | *.AppImage) printf '%s-%s.%s\n' "${1%.*}" "$hex" "${1##*.}" ;;
    *) printf '%s-%s\n' "$1" "$hex" ;;
  esac
}

# pin <asset>: release.json's SHA-256 for <asset> (its sha256 map), or nothing.
pin() {
  [ -f "$tmp/release.json" ] || return 0
  name="$(printf '%s' "$1" | sed 's/[.]/\\./g')"
  tr -d ' \t\r\n' < "$tmp/release.json" | sed -n "s/.*\"sha256\":{[^}]*\"$name\":\"\([0-9a-f]\{64\}\)\".*/\1/p"
}

# lists: the release's release.json, else (a release from before it) its SHA256SUMS, into $tmp.
lists() {
  get -o "$tmp/release.json" "$base/release.json" 2>/dev/null && return 0
  rm -f "$tmp/release.json"
  get -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
}

# fetch <asset> <dest> <what>: download one release asset and check it. Edge republishes its names in place, and a
# reader can get one build's checksums and another's bytes under them, so a release.json that pins <asset> names its
# build's own copy, which never changes: its checksum and bytes are always one build's. A release without pins is
# checked against SHA256SUMS: one going up replaces its assets first and SHA256SUMS last, so a mismatch reads both
# again, twice, 10 s apart, before it refuses.
fetch() {
  expected="$(pin "$1")"
  if [ -n "$expected" ]; then
    file="$(pinned "$1" "$expected")"
    download "$base/$file" "$2" "$3" || die "download failed: $base/$file
Check this machine's connection and run the installer again."
    actual="$(sha256 "$2")"
    [ "$actual" = "$expected" ] || die "checksum mismatch for $1 (expected $expected, got $actual); not installing
Run the installer again; if it keeps failing, report it at https://github.com/$REPO/issues."
    checked "$actual"
    return 0
  fi
  [ -f "$tmp/SHA256SUMS" ] || get -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "could not download $base/SHA256SUMS
Check this machine's connection and run the installer again."
  tries=0
  while :; do
    expected="$(awk -v n="$1" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")"
    [ -n "$expected" ] || return 1
    download "$base/$1" "$2" "$3" || die "download failed: $base/$1
Check this machine's connection and run the installer again."
    actual="$(sha256 "$2")"
    if [ "$actual" = "$expected" ]; then
      checked "$actual"
      return 0
    fi
    rm -f "$2"
    tries=$((tries + 1))
    [ "$tries" -le 2 ] || die "checksum mismatch for $1 (expected $expected, got $actual); not installing
Run the installer again; if it keeps failing, report it at https://github.com/$REPO/issues."
    warn "checksum mismatch for $1, perhaps a new release going up; checking again in 10 s"
    sleep 10
    get -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "could not download $base/SHA256SUMS
Check this machine's connection and run the installer again."
  done
}

# checked <sha256>: the download matched the release's checksum.
checked() { done_step Checksum "sha256 $(printf '%s' "$1" | cut -c1-12)… matches the release"; }

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
  asset="fleetd-bun-$os-$arch"
  mkdir -p "$bin_dir"
  if ! fetch "$asset" "$bin_dir/.fleetd.new" "the CLI"; then
    rm -f "$bin_dir/.fleetd.new"
    warn "no CLI for $os-$arch on the $channel channel yet; skipping it"
    return 0
  fi
  chmod 755 "$bin_dir/.fleetd.new"
  swap "$bin_dir/.fleetd.new" "$bin_dir/fleetd"
  mkdir -p "$HOME/.local/bin"
  link="$HOME/.local/bin/fleetd"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    done_step Install "$(tilde "$bin_dir/fleetd")"
    warn "$link exists and is not ours; leaving it (fleetd is at $bin_dir/fleetd)"
  else
    ln -sfn "$bin_dir/fleetd" "$link"
    done_step Install "$(tilde "$bin_dir/fleetd")"
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) done_step PATH "$(tilde "$link")" ;;
      *) add_path ;;
    esac
  fi
  installed=1
}

# The line add_path puts in a shell's startup file, and uninstall takes out again. Single quotes: it is written as is.
# shellcheck disable=SC2016
PATH_LINE='export PATH="$HOME/.local/bin:$PATH" # added by fleetd'

# profile: the startup file of this user's shell, where ~/.local/bin goes on PATH; nothing for a shell that takes no
# sh line (fish). bash on macOS opens login shells, which read ~/.bash_profile.
profile() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) if [ "$(uname -s)" = Darwin ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
    */fish) ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

# add_path: ~/.local/bin isn't on PATH, so `fleetd` alone isn't found: it goes on it for every new shell, in the
# shell's startup file, unless that file has a line for it already; this shell gets the line to paste.
add_path() {
  file="$(profile)"
  # shellcheck disable=SC2016
  now='export PATH="$HOME/.local/bin:$PATH"'
  if [ -z "$file" ]; then
    done_step PATH "$(tilde "$link")"
    warn "$(tilde "$HOME/.local/bin") isn't on your PATH: fish_add_path ~/.local/bin puts it there"
  elif [ -f "$file" ] && grep -q '\.local/bin' "$file"; then
    done_step PATH "$(tilde "$link") · $(tilde "$file") adds $(tilde "$HOME/.local/bin") in new shells"
    say "in this one, run: ${now}"
  elif printf '\n%s\n' "$PATH_LINE" >>"$file" 2>/dev/null; then
    done_step PATH "$(tilde "$link") · added $(tilde "$HOME/.local/bin") to PATH in $(tilde "$file")"
    say "new shells find fleetd; in this one, run: ${now}"
  else
    done_step PATH "$(tilde "$link")"
    warn "$(tilde "$HOME/.local/bin") isn't on your PATH, and $(tilde "$file") can't be written: add this line to your shell's startup file
${now}"
  fi
}

install_app_macos() {
  if ! fetch fleetd-desktop-macos-universal.zip "$tmp/app.zip" "the app"; then
    warn "no desktop app on the $channel channel yet; skipping it"
    return 0
  fi
  mkdir -p "$tmp/app" "$HOME/Applications"
  spin Unpack "the app" ditto -x -k "$tmp/app.zip" "$tmp/app"
  [ -d "$tmp/app/fleetd.app" ] || die "the app archive has no fleetd.app"
  rm -rf "$HOME/Applications/.fleetd.app.new"
  mv "$tmp/app/fleetd.app" "$HOME/Applications/.fleetd.app.new"
  gpui=0
  [ -e "$HOME/Applications/fleetd.app/Contents/MacOS/fleetd-app" ] && gpui=1
  swap "$HOME/Applications/.fleetd.app.new" "$HOME/Applications/fleetd.app"
  done_step Install "$(tilde "$HOME/Applications/fleetd.app")"
  [ "$gpui" = 0 ] || replaced_gpui
  installed=1
}

# The GPUI app had the same bundle id and place; a copy of it still open keeps running until it quits.
replaced_gpui() {
  say "it replaces the previous fleetd app: quit that one if it is open. The new app keeps its pairing."
}

# fuse2: whether the AppImage can mount itself, which takes FUSE 2's libfuse.so.2. Ubuntu 24.04 and other newer
# distributions don't install it, and the AppImage then exits at once ("AppImages require FUSE to run"). Without it
# the menu entry runs the app with APPIMAGE_EXTRACT_AND_RUN=1, which unpacks it at each start instead of mounting it.
# With no ldconfig to ask, it is taken as there.
fuse2() {
  ldconfig="$(command -v ldconfig 2>/dev/null || true)"
  for c in /sbin/ldconfig /usr/sbin/ldconfig; do
    [ -n "$ldconfig" ] || { [ -x "$c" ] && ldconfig="$c"; }
  done
  [ -n "$ldconfig" ] || return 0
  "$ldconfig" -p 2>/dev/null | grep -q 'libfuse\.so\.2'
}

install_app_linux() {
  if ! fetch fleetd-desktop-linux-x86_64.AppImage "$tmp/fleetd-desktop.AppImage" "the app"; then
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
  launch="$app_dir/fleetd-desktop.AppImage"
  nofuse=0
  if ! fuse2; then
    launch="env APPIMAGE_EXTRACT_AND_RUN=1 $launch"
    nofuse=1
  fi
  # Named after the app's Wayland app_id / WM_CLASS (desktopName in app/desktop/package.json), so its windows get
  # this entry's name and icon. %u hands a fleetd:// pairing link to the app.
  cat >"$apps_dir/.fleetd-desktop.desktop.new" <<DESKTOP
[Desktop Entry]
Type=Application
Name=fleetd
Comment=Watch and steer your software factory
Exec=$launch %u
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
  done_step Install "$(tilde "$app_dir/fleetd-desktop.AppImage")"
  done_step Menu "$(tilde "$apps_dir/fleetd-desktop.desktop")"
  [ "$nofuse" = 0 ] || warn "no FUSE 2 here (libfuse.so.2), so the app unpacks itself at each start
For a quicker start, install it: sudo apt install libfuse2t64 (libfuse2 before
Ubuntu 24.04), then run this installer again.
From a terminal: APPIMAGE_EXTRACT_AND_RUN=1 $(tilde "$app_dir/fleetd-desktop.AppImage")"
  [ "$gpui" = 0 ] || replaced_gpui
  installed=1
}

# units: fleetd's service files here, a path a line: what `fleetd init`, `machine add` and `init --join` write. One
# whose --home is outside ~/.fleetd runs another fleet (FLEETD_HOME), which `fleetd uninstall` leaves alone too.
units() {
  for u in "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/fleetd-hub.service" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/fleetd-node.service" \
    "$HOME/Library/LaunchAgents/sh.fleetd.hub.plist" "$HOME/Library/LaunchAgents/sh.fleetd.node.plist"; do
    [ -f "$u" ] || continue
    if grep -q -- '--home' "$u" && ! grep -qF "$HOME/.fleetd/" "$u"; then continue; fi
    printf '%s\n' "$u"
  done
}

# running [<what>]: the processes run from fleetd's CLI (<what> one of its commands, as session-host), "<pid> <command
# line>" a line. A binary an earlier uninstall deleted under a running node still shows its path.
running() {
  { ps -eo pid=,args= 2>/dev/null || ps -o pid=,args=; } | awk -v exe="$bin_dir/fleetd" -v what="${1:-}" '
    { pid = $1; sub(/^[ \t]*[0-9]+[ \t]+/, "") }
    index($0, exe) == 1 && (substr($0, length(exe) + 1, 1) == " " || length($0) == length(exe)) {
      if (what == "" || $2 == what) print pid " " $0
    }'
}

user_ctl() { XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user "$@"; }

# stop_units: what `fleetd uninstall` does, without the CLI (an uninstall from before W890 deleted it under a running
# node): each service stopped and its file removed, then the agents' session hosts, which outlive the node on purpose,
# told to stop as the CLI's `session-host stop-all` would.
stop_units() {
  units | while IFS= read -r u; do
    case "$u" in
      *.service)
        # Only the unit the user's manager loaded from this very file: a unit of the same name from elsewhere is
        # another fleetd's.
        name="${u##*/}"
        from="$(user_ctl show -p FragmentPath --value "$name" 2>/dev/null || true)"
        if [ -z "$from" ] || [ "$from" = "$u" ]; then user_ctl disable --now "$name" 2>/dev/null || true; fi
        ;;
      *.plist)
        label="${u##*/}"
        launchctl bootout "gui/$(id -u)/${label%.plist}" 2>/dev/null || true
        ;;
    esac
    rm -f "$u"
    say "stopped and removed $(tilde "$u")"
  done
  ! command -v systemctl >/dev/null 2>&1 || user_ctl daemon-reload 2>/dev/null || true
  # Only root removes the drop-in setup wrote for the user's service manager (the CLI's uninstall does, with sudo).
  dropin="/etc/systemd/system/user@$(id -u).service.d/fleetd.conf"
  if [ -f "$dropin" ]; then
    off=""
    ! grep -qx '# fleetd turned linger on' "$dropin" 2>/dev/null || off="; loginctl disable-linger $(id -un)"
    say "left ${dropin}, which only root can remove: sudo sh -c \"rm -f ${dropin}${off}; systemctl daemon-reload\""
  fi
  hosts="$(running session-host | cut -d' ' -f1)"
  # shellcheck disable=SC2086 # one pid a word
  [ -z "$hosts" ] || kill $hosts 2>/dev/null || true
  i=0
  while [ -n "$(running session-host)" ] && [ "$i" -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
}

# unpath: add_path's line out of each startup file it may be in, once nothing else is in ~/.local/bin, which other
# programs' installers use too.
unpath() {
  [ -z "$(ls -A "$HOME/.local/bin" 2>/dev/null)" ] || return 0
  for f in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    if [ ! -f "$f" ] || ! grep -qxF "$PATH_LINE" "$f"; then continue; fi
    grep -vxF "$PATH_LINE" "$f" >"$f.fleetd-tmp" || true
    cat "$f.fleetd-tmp" >"$f" && rm -f "$f.fleetd-tmp"
    say "took the PATH line out of $(tilde "$f")"
  done
}

# uninstall: fleetd's services stop and go first (`fleetd uninstall`), and only once none is left, and nothing runs from
# the CLI any more, do the CLI and the app go: a CLI deleted under a running node left it, and its agents, running
# from a deleted binary, and a service that crash-looped after the next reboot.
uninstall() {
  rc=127
  if [ -x "$bin_dir/fleetd" ]; then
    # Stops and removes this machine's services, the agents they left running and what setup arranged as root; keeps
    # their data.
    rc=0
    "$bin_dir/fleetd" uninstall || rc=$?
  fi
  # 126 and 127: no CLI that runs here (deleted, damaged, another machine's build). A CLI from before W890 removes only
  # the workspace's service and exits 0, so what it left goes the same way.
  case "$rc" in
    0) [ -z "$(units)" ] || stop_units ;;
    126 | 127) stop_units ;;
    *) die "fleetd uninstall stopped, so nothing else was removed
Fix what it said, then run the uninstall again." ;;
  esac
  left="$({
    units | sed 's/^/service: /'
    running | sed 's/^\([0-9]*\) \(.*\)$/running: pid \1, \2/'
  })"
  if [ -n "$left" ]; then
    die "fleetd still runs here, so its CLI stays for now
${left}
Stop what runs (kill <pid> for a fleetd you started yourself), then run the uninstall again."
  fi
  rm -rf "$bin_dir"
  link="$HOME/.local/bin/fleetd"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$bin_dir/fleetd" ]; then rm -f "$link"; fi
  unpath
  # fleetd.desktop is the GPUI app's menu entry.
  rm -rf "$HOME/Applications/fleetd.app" "$app_dir" "$apps_dir/fleetd.desktop" "$apps_dir/fleetd-desktop.desktop"
  rmdir "$app_dir_parent" "$HOME/.fleetd" 2>/dev/null || true
  done_step Remove "the fleetd CLI and app; no fleetd service or process is left"
  kept=""
  [ ! -d "$HOME/.fleetd" ] || kept="$(tilde "$HOME/.fleetd")"
  for d in "${XDG_CONFIG_HOME:-$HOME/.config}/fleetd" "$HOME/Library/Application Support/fleetd"; do
    [ ! -d "$d" ] || kept="${kept:+${kept} and }$(tilde "$d")"
  done
  if [ -n "$kept" ]; then
    footer "Your data in ${kept} is still there; delete it yourself if you want it gone."
  else
    footer "fleetd is gone from this machine."
  fi
}

# agents_mac_user: --mac joins the agents' Mac from the account logged in at its screen (an admin's is fine), where
# launchd runs its node. No app goes there.
agents_mac_user() {
  [ "$(uname -s)" = Darwin ] || die "--mac is for the agents' Mac: run the join line on a Mac, logged in at its screen"
  # launchd runs the node in the user's gui domain, which only a login at the Mac's screen makes (su and ssh don't).
  if ! launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
    die "$(id -un) isn't logged in on this Mac's screen, and launchd runs fleetd's node only inside that login
su and ssh don't make one. Log in as $(id -un) at the Mac (Apple menu › Lock Screen, then pick $(id -un); or
over Screen Sharing), open Terminal there, and paste the join line again; nothing was changed."
  fi
  want_app=no
}

# join_hub: `fleetd init --join` with what `fleetd pair --worker` printed, so it doesn't ask for them. The terminal, when there
# is one, is its stdin, as when the command is typed there.
join_hub() {
  set -- init --join "$join"
  # The code in fleetd's environment; only a build from before it read it there gets it as --code.
  if "$bin_dir/fleetd" help 2>/dev/null | grep -q FLEETD_JOIN_CODE; then
    FLEETD_JOIN_CODE="$code"
    export FLEETD_JOIN_CODE
  else
    set -- "$@" --code "$code"
  fi
  [ -z "$machine_id" ] || set -- "$@" --machine-id "$machine_id"
  [ -z "$git_identity" ] || set -- "$@" --git-identity "$git_identity"
  [ "$rejoin" = 0 ] || set -- "$@" --rejoin
  [ "$mac" = 0 ] || set -- "$@" --mac
  if (: </dev/tty) 2>/dev/null; then
    "$bin_dir/fleetd" "$@" </dev/tty
  else
    "$bin_dir/fleetd" "$@" </dev/null
  fi
}

main() {
  ui_init
  want_app=auto
  do_uninstall=0
  run_init=1
  join=""
  code="${FLEETD_JOIN_CODE:-}"
  # Read: nothing else this runs gets it, but fleetd init --join (join_hub).
  unset FLEETD_JOIN_CODE
  machine_id=""
  git_identity=""
  rejoin=0
  mac=0
  hub_version=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-app) want_app=no ;;
      --app) want_app=yes ;;
      --uninstall) do_uninstall=1 ;;
      --no-init) run_init=0 ;;
      --rejoin) rejoin=1 ;;
      --mac) mac=1 ;;
      --join | --code | --machine-id | --git-identity | --version)
        [ "$#" -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --join) join="$2" ;;
          --code) code="$2" ;;
          --machine-id) machine_id="$2" ;;
          --git-identity) git_identity="$2" ;;
          --version) hub_version="$2" ;;
        esac
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage >&2
        die "unknown option: $1"
        ;;
    esac
    shift
  done
  if [ -n "$join" ] || [ -n "$code" ]; then
    [ -n "$join" ] && [ -n "$code" ] ||
      die "--join and its code go together: both are in what fleetd pair --worker prints (the code in FLEETD_JOIN_CODE or --code)"
    [ "$run_init" = 1 ] || die "--no-init and --join contradict each other: --join runs fleetd init --join"
  elif [ -n "$machine_id$git_identity$hub_version" ] || [ "$rejoin" = 1 ] || [ "$mac" = 1 ]; then
    die "--machine-id, --git-identity, --rejoin, --mac and --version only go with --join and its code"
  fi
  [ "$mac" = 0 ] || agents_mac_user

  [ -n "${HOME:-}" ] || die "HOME is not set"
  bin_dir="$HOME/.fleetd/bin"
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  app_dir_parent="$data_home/fleetd"
  app_dir="$app_dir_parent/app"
  apps_dir="$data_home/applications"

  if [ "$do_uninstall" = 1 ]; then
    header "fleetd uninstall"
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
    *) die "unsupported CPU: $(uname -m) (fleetd runs on x86_64 and arm64)" ;;
  esac
  # An Intel shell under Rosetta on Apple silicon still gets the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi

  channel="${FLEETD_CHANNEL:-edge}"
  # The workspace's own channel, from its version.
  case "$hub_version" in
    "") ;;
    *-edge.* | *-nightly.*) channel=edge ;;
    *) channel=stable ;;
  esac
  case "$channel" in
    edge | nightly)
      channel=edge
      default_base="https://github.com/$REPO/releases/download/edge"
      ;;
    stable | latest)
      default_base="https://github.com/$REPO/releases/latest/download"
      [ -z "$hub_version" ] || default_base="https://github.com/$REPO/releases/download/v${hub_version#v}"
      ;;
    *) die "FLEETD_CHANNEL must be edge or stable, not $channel" ;;
  esac
  base="${FLEETD_BASE_URL:-$default_base}"
  header "fleetd install"

  if [ "$os" = darwin ]; then
    macos="$(sw_vers -productVersion 2>/dev/null || true)"
    case "${macos%%.*}" in
      "" | *[!0-9]*) ;;
      *) [ "${macos%%.*}" -ge 13 ] || die "fleetd's CLI and workspace need macOS 13 or newer, and this Mac runs ${macos}; nothing was changed." ;;
    esac
  fi
  platform="$os $arch"
  [ "$os" != darwin ] || platform="macOS $(sw_vers -productVersion 2>/dev/null || true) $arch"
  done_step Platform "$platform"
  command -v curl >/dev/null 2>&1 || die "need curl to download fleetd
Install it with this machine's package manager (sudo apt install curl, say), then run the installer again."
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t fleetd)"
  # A download still running in the background goes with the script, and so does the hidden cursor, and what it left
  # half written (a dropped network, Ctrl-C): a finished step has renamed its .new into place already.
  trap '[ -z "$job" ] || kill "$job" 2>/dev/null; rm -rf "$tmp" "${bin_dir}/.fleetd.new" "${HOME}/Applications/.fleetd.app.new" "${app_dir}.new"; unlive; [ "$rich" = 0 ] || printf "\033[?25h"' EXIT
  trap 'exit 1' INT TERM
  # release.json first: it names the channel's build and pins its assets (fetch). A release without one has SHA256SUMS.
  if ! spin Release "looking for the $channel release" lists; then
    # Until the first edge build is out, the nightly release has the newest; from then on it is a copy of edge.
    if [ "$base" = "https://github.com/$REPO/releases/download/edge" ]; then
      base="https://github.com/$REPO/releases/download/nightly"
    fi
    # A workspace built from source runs a version no release was made for: the newest stable build joins it.
    if [ "$base" = "https://github.com/$REPO/releases/download/v${hub_version#v}" ]; then
      warn "there is no release of fleetd $hub_version, the workspace's version, so this machine gets the newest stable one"
      base="https://github.com/$REPO/releases/latest/download"
    fi
    if ! spin Release "looking for the $channel release" lists; then
      # Every build of fleetd is published on edge (D701), and none on stable yet: GitHub has no latest release.
      if [ "$channel" = stable ] && [ -z "$hub_version" ] && [ -z "${FLEETD_BASE_URL:-}" ]; then
        die "fleetd has no stable release yet
Every build goes out on the edge release, with a staged rollout: run the installer without FLEETD_CHANNEL."
      fi
      die "could not download $base/release.json or $base/SHA256SUMS
Check this machine's connection, and that the $channel channel has a release, then run the installer again."
    fi
  fi
  version=""
  [ ! -f "$tmp/release.json" ] ||
    version="$(tr -d '\n' < "$tmp/release.json" | sed -n 's/.*"cliVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  done_step Release "$channel${version:+ · $version}"

  # The edge release holds the workspace's build until main moves on: then this machine gets the newer one, and says so.
  if [ "$channel" = edge ] && [ -n "$hub_version" ] && [ -f "$tmp/release.json" ]; then
    edge_now="$(tr -d '\n' < "$tmp/release.json" | sed -n 's/.*"cliVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [ -n "$edge_now" ] && [ "$edge_now" != "$hub_version" ]; then
      say "your workspace runs an older edge build ($hub_version) than the newest ($edge_now), which this machine gets. To bring the workspace level, press Update in the app on your main machine (or run fleetd update on the workspace's machine)."
    fi
  fi

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
  [ "$installed" = 1 ] || die "nothing to install from $base
There is no fleetd build for $os-$arch on the $channel channel yet."

  if [ ! -x "$bin_dir/fleetd" ]; then
    [ -z "$join" ] || die "no fleetd CLI here to join $join with"
    footer "Installed the fleetd app."
    return 0
  fi
  summary="Installed fleetd${version:+ $version}"
  if [ -n "$join" ]; then
    footer "$summary. Joining the workspace at $join"
    join_hub
    return
  fi
  # `curl | sh` has the script on stdin, so the wizard reads the terminal itself. Without one (CI, a pipe), or with
  # --no-init, only the next command is printed. The binary is in place either way; Ctrl-C in the wizard leaves it.
  if [ "$run_init" = 1 ] && [ -t 2 ] && (: </dev/tty) 2>/dev/null; then
    footer "$summary. Setting it up with fleetd init"
    status=0
    "$bin_dir/fleetd" init </dev/tty || status=$?
    return "$status"
  fi
  # shellcheck disable=SC2088 # the tilde is printed for the user to type
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) next="fleetd init" ;;
    *) next="~/.local/bin/fleetd init" ;;
  esac
  if [ "$rich" = 1 ]; then
    footer "$summary" "Next, run $(paint 1 "$next")"
  else
    footer "$summary in $(tilde "$bin_dir/fleetd")" "
Next, run:
  $next"
  fi
}

main "$@"
