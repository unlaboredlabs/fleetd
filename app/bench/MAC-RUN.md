# Running the speed baseline on a Mac

For an agent (or person) on a Mac. Takes about 10 minutes of building and 3 minutes of measuring, and
ends with the same markdown table the Linux run prints. It only builds and launches `fleetd-app` from a
fresh checkout; it does not touch any T3 server, proxy or other app on the Mac.

## 1. Prerequisites

- **Command Line Tools** (full Xcode is not needed). Check with `xcode-select -p`. If that fails, run
  `xcode-select --install` and click through the installer (a person has to do this). Our gpui build
  turns on `runtime_shaders`, which compiles the Metal shaders when the app starts, so the
  `xcrun metal` compiler that only ships with full Xcode is never called. CI builds the app with only
  the Command Line Tools selected, which proves this works.
- **Rust stable 1.98 or newer**. Check with `rustc --version`. If Rust is missing, install it per user
  with `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, then
  `source ~/.cargo/env`. If it is too old, run `rustup update stable`.
- **git**, which comes with the Command Line Tools.
- The Mac must be **awake and unlocked, with the display on**, for the whole run. macOS stops
  presenting frames for windows it can't show, so a locked screen makes every measurement time out.

## 2. Get the code

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/unlaboredlabs/fleetd.git fleetd-bench
cd fleetd-bench
git log -1 --format='%h %s'
```

If `~/src/fleetd-bench` already exists, run `git -C ~/src/fleetd-bench pull --ff-only` instead.

## 3. Run

```sh
app/bench/run.sh | tee /tmp/fleetd-mac-baseline.md
```

The first run builds in release mode, which takes several minutes. Then a fleetd window opens and
closes about 35 times; leave the keyboard and mouse alone. Progress goes to stderr, and the table goes
to stdout and `/tmp/fleetd-mac-baseline.md`.

If `xcrun --find metal` succeeds (full Xcode is installed), also run the build with precompiled shaders
so we can see what runtime shader compilation costs at startup:

```sh
app/bench/run.sh --precompiled-shaders | tee /tmp/fleetd-mac-baseline-precompiled.md
```

## 4. Report

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
  the script does not run.
- **RSS**: read with `ps -o rss=` (resident set size), as on Linux. Activity Monitor's "Memory" column
  shows the physical footprint instead, which is a different number.
