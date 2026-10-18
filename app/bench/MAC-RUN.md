# Running the speed baseline on a Mac

For an agent (or person) on a Mac. Two ways, both ending with numbers to send back:

- **Quick: the nightly zip, no checkout** (about 3 minutes). Cold start, RAM, in-app input latency and scroll,
  measured on the released `fleetd.app`. Needs nothing but the zip and the stock `zsh`.
- **Full table: the `fleetd-bench` driver** (about 10 minutes of building, then 3 of measuring). The same
  markdown table the Linux run prints, for `app/bench/BASELINE.md`. Needs Rust and a checkout.

Neither touches a T3 server, a hub, the keychain, or any other app: in bench mode the app shows fixture
data and talks to nothing. The Mac must be **awake and unlocked, with the display on**, for the whole run,
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

## Quick: from the nightly zip

1. Download `fleetd-app-macos-universal.zip` from the nightly release and unzip it (Safari does this
   itself), so the app is at `~/Downloads/fleetd.app`. Elsewhere, set `FLEETD_APP` to its
   `Contents/MacOS/fleetd-app` before step 2.
2. Paste this into Terminal:

```sh
zsh <<'EOF'
zmodload zsh/datetime
app=${FLEETD_APP:-$HOME/Downloads/fleetd.app/Contents/MacOS/fleetd-app}
out=$HOME/Desktop/fleetd-mac-bench.txt
# median, p90 and max of numbers on stdin, picked the way fleetd-bench picks them
stats() { sort -n | awk '{v[NR]=$1} END {if (!NR) {print "no samples"; exit}
  printf "median %.1f, p90 %.1f, max %.1f (n=%d)\n", v[int((NR-1)*0.5+1.5)], v[int((NR-1)*0.9+1.5)], v[NR], NR}'; }
{
  echo "$($app --version), macOS $(sw_vers -productVersion), $(sysctl -n hw.model), $(sysctl -n machdep.cpu.brand_string)"
  echo "Cold start, exec -> first frame presented, warm cache, ms: $(for i in {0..10}; do
    t0=$EPOCHREALTIME
    ns=$(FLEETD_BENCH=cold $app | sed -n 's/.*event=first_present unix_ns=\([0-9]*\).*/\1/p')
    (( i )) && printf '%.1f\n' $(( (ns / 1e9 - t0) * 1000 )) # run 0 warms the cache
  done | stats)"
  for label envs in \
      "Idle RSS, empty log, 10 s after first frame" "FLEETD_HISTORY=0 FLEETD_STREAM=0" \
      "Idle RSS, 20k-line log loaded, 10 s after first frame" "FLEETD_STREAM=0" \
      "RSS, 20k-line log + streaming 50 lines/s, after 10 s" ""; do
    log=$(mktemp)
    env FLEETD_BENCH=idle ${=envs} $app > $log & pid=$!
    until grep -q first_present $log || ! kill -0 $pid 2>/dev/null; do sleep 0.2; done
    sleep 10
    printf '%s: %.1f MiB\n' $label $(( $(ps -o rss= -p $pid) / 1024.0 ))
    kill $pid; wait $pid 2>/dev/null; rm -f $log
  done
  echo "Input latency in-app, key handler -> echo frame presented (gpui dispatch), ms: $(FLEETD_BENCH=keys-internal $app |
    sed -n 's/.*event=key key=[a-z] latency_ns=\([0-9]*\).*/\1/p' | awk '{printf "%.3f\n", $1 / 1e6}' | stats)"
  echo "Scroll 20k-line log for 5 s: $(FLEETD_BENCH=scroll $app | sed -n 's/.*event=scroll //p')"
} 2>&1 | tee $out
EOF
```

The cold start here includes a few ms of shell overhead that the driver doesn't have.

3. Send back `~/Desktop/fleetd-mac-bench.txt`, plus the Mac model, the display (built-in Retina,
   external, refresh rate) and whether it was on battery. If anything failed, also send
   `~/.fleetd/app.log`.

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
`bench/mac-baseline`, and open a PR (or send the tables to Wynn). Record the Mac model, display
(Retina or not) and whether it was on battery.

## What differs from the Linux run

- **Rendering**: Metal on the real GPU, at the display's refresh rate (60 or 120 Hz). Linux on forge is
  software-rendered for now, so don't compare the two directly.
- **Input latency**: on the Mac only the in-app number is measured. Keystrokes go through gpui's own
  dispatch, and the clock stops when the frame showing the echo is presented. The external measurement
  on Linux types through XTEST and reads pixels back from X; there is no permission-free equivalent on
  macOS, because posting synthetic key events needs an Accessibility grant.
- **Cold start**: there is only a warm-cache number. Evicting the page cache needs `sudo purge`, which
  neither route runs.
- **RSS**: read with `ps -o rss=` (resident set size), as on Linux. Activity Monitor's "Memory" column
  shows the physical footprint instead, which is a different number.
