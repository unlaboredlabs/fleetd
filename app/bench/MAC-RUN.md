# Running the speed baseline on a Mac

For an agent (or person) on a Mac. Two ways, both ending with numbers to send back:

- **Quick: the nightly zip, no checkout** (about 3 minutes). Cold start, RAM, in-app input latency and scroll,
  measured on the released `fleetd.app`. Needs nothing but the zip and the stock `zsh`.
- **Full table: the `fleetd-bench` driver** (about 10 minutes of building, then 3 of measuring). The same
  markdown table the Linux run prints, for `app/bench/BASELINE.md`. Needs Rust and a checkout.

In bench mode the app shows fixture data and touches no hub, node, keychain or other app: no network, no
notifications, no prompts. The Mac must be **awake and unlocked, with the display on**, for the whole run,
because macOS stops presenting frames for windows it can't show. A fleetd window opens and closes about
15 (quick) or 35 (full) times; leave the keyboard and mouse alone.

## How bench mode works

`FLEETD_BENCH=<mode>` on `fleetd-app` (the binary at `fleetd.app/Contents/MacOS/fleetd-app`) runs one
measurement and prints `FLEETD_BENCH key=value ...` lines on stdout. The mode is a name, not a flag:

| Mode | What it does |
|---|---|
| `cold` | Prints `event=first_present unix_ns=<wall clock of the first presented frame>`, then quits. |
| `idle` | Same line, then sits idle until killed (for RSS). `FLEETD_HISTORY=0` empties the log, `FLEETD_STREAM=0` stops streaming. |
| `keys-internal` | Types 200 keys through gpui's own dispatch, prints `event=key key=<k> latency_ns=<key handler -> echo frame presented>` per key, then quits. |
| `scroll` | Scrolls a 20k-line log for 5 s, prints `event=scroll fps=... worst_frame_us=...`, then quits. |

Any other value (such as `FLEETD_BENCH=1`) prints the list of modes and exits with status 2. If the app
ever panics it says where on stderr and appends the same report to `~/.fleetd/app.log`.

Startup progress goes to **stderr**, one line per milestone, timed from the start of `main`:
`FLEETD_BENCH stage=<name> t_ms=<ms>`. In order: `process_start`, `platform_ready` (gpui's platform
is set up and AppKit's launch starts), `app_launched` (AppKit has finished launching and handed over),
`window_opening` (the displays and the window's bounds), `window_created` (`active=`, `visible=`,
`bounds=`, `scale=`), `activate_requested`, `visibility` and `activation` whenever those change, `first_draw`, `first_present`. A run with no presented frame after 15 s prints
`FLEETD_BENCH stage=timeout last=<last stage reached>` and exits with status 3 (`FLEETD_BENCH_TIMEOUT_MS`
sets the limit; 0 turns it off).

| `last=` | Where it stopped |
|---|---|
| `process_start` | Before AppKit handed over, usually behind a modal alert of AppKit's own. |
| `window_created`, `activate_requested` | The window exists but macOS isn't showing it (`visible=false`): display asleep, screen locked, another Space. |
| `first_draw` | Drawn but never presented: the GPU or the display link. |

## Quick: from the nightly zip

1. Download `fleetd-app-macos-universal.zip` from the nightly release and unzip it (Safari does this
   itself), so the app is at `~/Downloads/fleetd.app`. Elsewhere, set `FLEETD_APP` to its
   `Contents/MacOS/fleetd-app` before step 2.
2. Paste this into Terminal. A diagnostic run comes first; if startup stops, its stage lines say where,
   and the rest is skipped.

```sh
zsh <<'EOF'
zmodload zsh/datetime
app=${FLEETD_APP:-$HOME/Downloads/fleetd.app/Contents/MacOS/fleetd-app}
out=$HOME/Desktop/fleetd-mac-bench.txt
err=$(mktemp)
# median, p90 and max of numbers on stdin, picked the way fleetd-bench picks them
stats() { sort -n | awk '{v[NR]=$1} END {if (!NR) {print "no samples"; exit}
  printf "median %.1f, p90 %.1f, max %.1f (n=%d)\n", v[int((NR-1)*0.5+1.5)], v[int((NR-1)*0.9+1.5)], v[NR], NR}'; }
# A run with no frame after 15 s exits 3; this prints its stage log.
failed() { echo "$1 failed${2:+ (exit $2)}. Its stderr:"; sed 's/^/  /' $err; }
{
  echo "$($app --version), macOS $(sw_vers -productVersion), $(sysctl -n hw.model), $(sysctl -n machdep.cpu.brand_string)"
  echo "Diagnostic cold start:"
  FLEETD_BENCH=cold $app 2>$err >/dev/null; code=$?
  sed 's/^/  /' $err
  if (( code )); then echo "The diagnostic run failed (exit $code); startup stopped after the last stage above."; exit 1; fi
  echo "Cold start, exec -> first frame presented, warm cache, ms: $(for i in {0..10}; do
    t0=$EPOCHREALTIME
    ns=$(FLEETD_BENCH=cold $app 2>$err | sed -n 's/.*event=first_present unix_ns=\([0-9]*\).*/\1/p')
    [[ -z $ns ]] && { failed "Cold run $i" >&2; continue; }
    (( i )) && printf '%.1f\n' $(( (ns / 1e9 - t0) * 1000 )) # run 0 warms the cache
  done | stats)"
  for label envs in \
      "Idle RSS, empty log, 10 s after first frame" "FLEETD_HISTORY=0 FLEETD_STREAM=0" \
      "Idle RSS, 20k-line log loaded, 10 s after first frame" "FLEETD_STREAM=0" \
      "RSS, 20k-line log + streaming 50 lines/s, after 10 s" ""; do
    log=$(mktemp)
    env FLEETD_BENCH=idle ${=envs} $app > $log 2>$err & pid=$!
    until grep -q first_present $log || ! kill -0 $pid 2>/dev/null; do sleep 0.2; done
    if grep -q first_present $log; then
      sleep 10
      printf '%s: %.1f MiB\n' $label $(( $(ps -o rss= -p $pid) / 1024.0 ))
      kill $pid; wait $pid 2>/dev/null
    else
      wait $pid; failed $label $?
    fi
    rm -f $log
  done
  echo "Input latency in-app, key handler -> echo frame presented (gpui dispatch), ms: $(FLEETD_BENCH=keys-internal $app 2>$err |
    sed -n 's/.*event=key key=[a-z] latency_ns=\([0-9]*\).*/\1/p' | awk '{printf "%.3f\n", $1 / 1e6}' | stats)"
  echo "Scroll 20k-line log for 5 s: $(FLEETD_BENCH=scroll $app 2>$err | sed -n 's/.*event=scroll //p')"
} 2>&1 | tee $out
rm -f $err
EOF
```

The cold start here includes a few ms of shell overhead that the driver doesn't have.

3. Send back `~/Desktop/fleetd-mac-bench.txt`, plus the Mac model, the display (built-in Retina,
   external, refresh rate) and whether it was on battery. If anything failed, also send
   `~/.fleetd/app.log`.

If the diagnostic run stops at `last=process_start` with a window on screen, that window is an AppKit
alert and a person has to read it (`screencapture` needs a Screen Recording grant). Builds after
nightly 20261018.49e63ae turn AppKit's window restoration off; on older builds an earlier crashed launch
leaves a "quit unexpectedly while reopening windows" alert armed, which
`rm -rf ~/Library/Saved\ Application\ State/sh.fleetd.app.savedState` clears.

## Full table: the driver

### Prerequisites

- **Command Line Tools** (full Xcode is not needed). Check with `xcode-select -p`. If that fails, run
  `xcode-select --install` and click through the installer (a person has to do this). Our gpui build
  turns on `runtime_shaders`, which compiles the Metal shaders when the app starts, so the
  `xcrun metal` compiler that only ships with full Xcode is never called. CI builds the app with only
  the Command Line Tools selected, which proves this works.
- **Rust stable 1.98 or newer**. Check with `rustc --version`. If Rust is missing, install it per user
  with `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, then
  `source ~/.cargo/env`. If it is too old, run `rustup update stable`.
- **git**, which comes with the Command Line Tools.

### Get the code

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/unlaboredlabs/fleetd.git fleetd-bench
cd fleetd-bench
git log -1 --format='%h %s'
```

If `~/src/fleetd-bench` already exists, run `git -C ~/src/fleetd-bench pull --ff-only` instead.

### Run

```sh
app/bench/run.sh | tee /tmp/fleetd-mac-baseline.md
```

This builds `fleetd-app` in release from the checkout (several minutes the first time), then measures it.
Progress goes to stderr, and the table goes to stdout and `/tmp/fleetd-mac-baseline.md`.

To measure the released nightly binary instead of a local build, build only the driver and point it at
the app (from the checkout):

```sh
cargo build --release --locked -p fleetd-bench
env -i HOME="$HOME" PATH="$PATH" USER="$USER" LANG="${LANG:-en_US.UTF-8}" target/release/fleetd-bench \
  ~/Downloads/fleetd.app/Contents/MacOS/fleetd-app --runs 10 \
  --label "$(hostname -s), macOS $(sw_vers -productVersion), nightly $(~/Downloads/fleetd.app/Contents/MacOS/fleetd-app --version)" \
  | tee /tmp/fleetd-mac-baseline-nightly.md
```

If `xcrun --find metal` succeeds (full Xcode is installed), also run the build with precompiled shaders
so we can see what runtime shader compilation costs at startup:

```sh
app/bench/run.sh --precompiled-shaders | tee /tmp/fleetd-mac-baseline-precompiled.md
```

### Report

Put each table under "macOS" in `app/bench/BASELINE.md`, replacing the "pending" line, on a branch
`bench/mac-baseline`, and open a PR (or send the tables to a maintainer). Record the Mac model, display
(Retina or not) and whether it was on battery.

## What differs from the Linux run

- **Rendering**: Metal on the real GPU, at the display's refresh rate (60 or 120 Hz). The Linux run is
  software-rendered for now, so don't compare the two directly.
- **Input latency**: on the Mac only the in-app number is measured. Keystrokes go through gpui's own
  dispatch, and the clock stops when the frame showing the echo is presented. The external measurement
  on Linux types through XTEST and reads pixels back from X; there is no permission-free equivalent on
  macOS, because posting synthetic key events needs an Accessibility grant.
- **Cold start**: there is only a warm-cache number. Evicting the page cache needs `sudo purge`, which
  neither route runs.
- **RSS**: read with `ps -o rss=` (resident set size), as on Linux. Activity Monitor's "Memory" column
  shows the physical footprint instead, which is a different number.
