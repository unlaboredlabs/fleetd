# fleetd-app speed baseline

Produced by `app/bench/run.sh`. Re-run it at each milestone and add a section; don't overwrite old
sections. The method notes below say what each number means.

## Linux (forge): software-rendered (lavapipe, no GPU)

**Software-rendered (lavapipe, no GPU).** These numbers record the scaffold and measure the harness. Don't judge
GPUI or the app by them: every frame is rasterized on the CPU by Mesa lavapipe into a headless Xvfb.

**forge**, Linux 7.0.0-38-generic, AMD Ryzen 9 9955HX 16-Core Processor, Xvfb 1600x1000, software-rendered (lavapipe, no GPU). 2026-10-17T10:28Z, fleetd 2683b58, gpui zed v1.24.2 (fb69067).

| Metric | Value |
|---|---|
| Binary size (release, stripped) | 22.7 MiB |
| Idle RSS, empty log, 10 s after first frame | 129.8 MiB |
| Idle RSS, 20k-line log loaded, 10 s after first frame | 135.3 MiB |
| RSS, 20k-line log + streaming 50 lines/s, after 10 s | 147.7 MiB |
| Cold start, exec -> first frame presented, warm cache (10 runs) | median 73.2 ms, p90 74.1 ms, max 74.8 ms |
|   of which: exec -> first frame draw starts | median 49.3 ms, p90 50.6 ms, max 50.7 ms |
| Cold start, binary + 36 mapped files evicted from page cache (10 runs) | median 215.2 ms, p90 216.2 ms, max 219.1 ms |
| Input latency in-app, key handler -> echo frame presented (200 keys, gpui dispatch) | median 12.5 ms, p90 18.6 ms, max 24.0 ms |
| Input latency in-app, key handler -> echo frame presented (200 XTEST keys) | median 12.2 ms, p90 15.7 ms, max 26.8 ms |
| Input latency external, XTEST send -> echo pixels readable from X (200 keys) | median 13.7 ms, p90 17.4 ms, max 33.3 ms |
| Scroll 20k-line log for 5 s: presented frames/s | 62.4 |
| Scroll 20k-line log for 5 s: worst frame interval | 23.5 ms |

What shapes these numbers, besides the app:
- **RSS**: about 59 MiB of the idle RSS is resident LLVM (51 MiB) and lavapipe (7 MiB) code, from
  `/proc/<pid>/smaps`. Part of the 38 MiB of anonymous memory is lavapipe's CPU-side swapchain images.
  The 20k-line log adds about 5 MiB.
- **Evicted cold start**: the evicted files include the 132 MiB `libLLVM.so` that lavapipe needs, so
  most of the extra ~140 ms is reading LLVM from disk. With a GPU driver it would be far smaller.
- **Input latency and scroll**: gpui's X11 backend draws on a timer at the screen's refresh rate (60 Hz on
  Xvfb), so a key waits on average half a frame (about 8 ms) before its frame starts. Scroll holds 60 fps
  under lavapipe.

## Linux (forge): A1, the app as a hub client, software-rendered

Since A1 the bench runs the real app on fixture data, with no hub and no keychain: the project
detail screen (workstreams, plus the 20k-line log as the lead's tail), the sidebar and the reply bar.
The scaffold's three panes are gone. Same machine and method as above.

**forge**, Linux 7.0.0-38-generic, AMD Ryzen 9 9955HX 16-Core Processor, Xvfb 1600x1000, software-rendered (lavapipe, no GPU). 2026-10-17T12:42Z, fleetd 3c22727, gpui zed v1.24.2 (fb69067).

| Metric | Value |
|---|---|
| Binary size (release, stripped) | 25.0 MiB |
| Idle RSS, empty log, 10 s after first frame | 125.8 MiB |
| Idle RSS, 20k-line log loaded, 10 s after first frame | 131.1 MiB |
| RSS, 20k-line log + streaming 50 lines/s, after 10 s | 144.1 MiB |
| Cold start, exec -> first frame presented, warm cache (10 runs) | median 69.9 ms, p90 71.0 ms, max 71.6 ms |
|   of which: exec -> first frame draw starts | median 49.9 ms, p90 51.7 ms, max 52.0 ms |
| Cold start, binary + 36 mapped files evicted from page cache (10 runs) | median 212.4 ms, p90 213.1 ms, max 229.5 ms |
| Input latency in-app, key handler -> echo frame presented (200 keys, gpui dispatch) | median 10.7 ms, p90 15.9 ms, max 23.0 ms |
| Input latency in-app, key handler -> echo frame presented (200 XTEST keys) | median 12.3 ms, p90 14.2 ms, max 22.7 ms |
| Input latency external, XTEST send -> echo pixels readable from X (200 keys) | median 13.6 ms, p90 15.5 ms, max 28.5 ms |
| Scroll 20k-line log for 5 s: presented frames/s | 62.4 |
| Scroll 20k-line log for 5 s: worst frame interval | 24.7 ms |

Against the scaffold baseline, everything is within run-to-run noise except binary size:
- +2.3 MiB binary: keyring (Secret Service over zbus), async-tungstenite and serde.
- Idle RSS: -4.0 / -4.2 / -3.6 MiB.
- Cold start: -3.3 ms median (warm), -2.8 ms median (evicted).
- Input latency medians: -1.8 / +0.1 / -0.1 ms.
- Scroll: 62.4 fps either way; worst frame 24.7 vs 23.5 ms.

The bench can't cover the connected path, so it was measured by hand in the lab (not part of `run.sh`):
release build, Xvfb, a seeded lab hub with 6 projects and 4 open asks, VmRSS 12 s after spawn, 3 runs.

| Connected path | Value |
|---|---|
| Idle RSS, key from `FLEETD_HUB_URL`/`FLEETD_AGENT_KEY`, on the inbox | 134.7-135.1 MiB |
| Idle RSS, key loaded from the OS keychain (gnome-keyring in a private D-Bus session), on the inbox | 136.8-137.6 MiB |

Reading the keychain happens off the UI thread after the first frame, so it doesn't delay cold start.

## Linux (forge): TLS for https/wss hubs, software-rendered

Adds rustls on ring with the OS certificate verifier. Same bench as the A1 section above.

**forge**, Linux 7.0.0-38-generic, AMD Ryzen 9 9955HX 16-Core Processor, Xvfb 1600x1000, software-rendered (lavapipe, no GPU). 2026-10-17T12:55Z, fleetd 5be24df plus the TLS change, gpui zed v1.24.2 (fb69067).

| Metric | Value |
|---|---|
| Binary size (release, stripped) | 26.5 MiB |
| Idle RSS, empty log, 10 s after first frame | 125.7 MiB |
| Idle RSS, 20k-line log loaded, 10 s after first frame | 131.7 MiB |
| RSS, 20k-line log + streaming 50 lines/s, after 10 s | 143.9 MiB |
| Cold start, exec -> first frame presented, warm cache (10 runs) | median 68.9 ms, p90 70.8 ms, max 72.1 ms |
|   of which: exec -> first frame draw starts | median 49.3 ms, p90 50.9 ms, max 52.6 ms |
| Cold start, binary + 36 mapped files evicted from page cache (10 runs) | median 212.7 ms, p90 214.7 ms, max 215.6 ms |
| Input latency in-app, key handler -> echo frame presented (200 keys, gpui dispatch) | median 10.5 ms, p90 15.8 ms, max 21.0 ms |
| Input latency in-app, key handler -> echo frame presented (200 XTEST keys) | median 12.0 ms, p90 14.1 ms, max 19.1 ms |
| Input latency external, XTEST send -> echo pixels readable from X (200 keys) | median 13.6 ms, p90 15.3 ms, max 34.5 ms |
| Scroll 20k-line log for 5 s: presented frames/s | 62.2 |
| Scroll 20k-line log for 5 s: worst frame interval | 27.1 ms |

Against the A1 section above:
- +1.5 MiB binary (rustls, ring, rustls-platform-verifier).
- Everything else within noise: cold start median -1.0 ms (warm), +0.3 ms (evicted).
- Startup can't pay for TLS: the certificate roots load only on the first wss:// connect, on a
  background thread.
- Connected idle RSS, measured by hand in the lab (same hub, 3 runs each): 137.5 MiB over
  wss:// through a TLS terminator, against 136.1 MiB over ws://.

## Linux (forge): M8 inbox kinds, software-rendered

Approve asks show their stored argv with Approve/Reject, secret asks point to the phone or web app, checklists get a
"✓ done" tick, and the approve ask's command is a typed struct. Same bench as the TLS section above.

**forge**, Linux 7.0.0-38-generic, AMD Ryzen 9 9955HX 16-Core Processor, Xvfb 1600x1000, software-rendered (lavapipe, no GPU). 2026-10-17T16:11Z, fleetd 39f94e5 plus the M8b change, gpui zed v1.24.2 (fb69067).

| Metric | Value |
|---|---|
| Binary size (release, stripped) | 26.5 MiB |
| Idle RSS, empty log, 10 s after first frame | 126.3 MiB |
| Idle RSS, 20k-line log loaded, 10 s after first frame | 132.2 MiB |
| RSS, 20k-line log + streaming 50 lines/s, after 10 s | 144.3 MiB |
| Cold start, exec -> first frame presented, warm cache (10 runs) | median 71.8 ms, p90 72.5 ms, max 72.7 ms |
|   of which: exec -> first frame draw starts | median 51.6 ms, p90 52.4 ms, max 52.4 ms |
| Cold start, binary + 36 mapped files evicted from page cache (10 runs) | median 212.9 ms, p90 216.2 ms, max 217.5 ms |
| Input latency in-app, key handler -> echo frame presented (200 keys, gpui dispatch) | median 11.3 ms, p90 16.8 ms, max 29.2 ms |
| Input latency in-app, key handler -> echo frame presented (200 XTEST keys) | median 11.9 ms, p90 14.3 ms, max 22.6 ms |
| Input latency external, XTEST send -> echo pixels readable from X (200 keys) | median 13.7 ms, p90 15.7 ms, max 32.0 ms |
| Scroll 20k-line log for 5 s: presented frames/s | 62.0 |
| Scroll 20k-line log for 5 s: worst frame interval | 26.2 ms |

Against the TLS section above:
- Binary size unchanged (26.5 MiB).
- Idle RSS within noise: +0.6 / +0.5 / +0.4 MiB.
- Cold start median +2.9 ms (warm), +0.2 ms (evicted); input latency medians +0.8 / -0.1 / +0.1 ms; scroll
  62.0 fps, worst frame 26.2 ms. The bench screen (project detail) doesn't draw the inbox, and earlier sections'
  warm medians already span 68.9-73.2 ms, so we read the cold-start change as run-to-run noise.

## Linux (forge): every human action in the app, software-rendered

Secret asks are entered masked and sealed in the app (crypto_box), checklist commands get Copy buttons, and the app
posts native "needs you" notifications from the hub's `attention` field. Same bench as the M8 section above.

**forge**, Linux 7.0.0-38-generic, AMD Ryzen 9 9955HX 16-Core Processor, Xvfb 1600x1000, software-rendered (lavapipe, no GPU). 2026-10-17T21:09Z, fleetd f730744, gpui zed v1.24.2 (fb69067).

| Metric | Value |
|---|---|
| Binary size (release, stripped) | 26.7 MiB |
| Idle RSS, empty log, 10 s after first frame | 126.0 MiB |
| Idle RSS, 20k-line log loaded, 10 s after first frame | 131.9 MiB |
| RSS, 20k-line log + streaming 50 lines/s, after 10 s | 143.6 MiB |
| Cold start, exec -> first frame presented, warm cache (10 runs) | median 70.8 ms, p90 72.0 ms, max 73.1 ms |
|   of which: exec -> first frame draw starts | median 51.1 ms, p90 52.1 ms, max 52.1 ms |
| Cold start, binary + 36 mapped files evicted from page cache (10 runs) | median 214.7 ms, p90 216.2 ms, max 218.1 ms |
| Input latency in-app, key handler -> echo frame presented (200 keys, gpui dispatch) | median 10.8 ms, p90 16.0 ms, max 20.2 ms |
| Input latency in-app, key handler -> echo frame presented (200 XTEST keys) | median 12.2 ms, p90 14.1 ms, max 17.3 ms |
| Input latency external, XTEST send -> echo pixels readable from X (200 keys) | median 13.8 ms, p90 15.3 ms, max 20.2 ms |
| Scroll 20k-line log for 5 s: presented frames/s | 62.2 |
| Scroll 20k-line log for 5 s: worst frame interval | 28.3 ms |

Against the M8 section above:
- +0.2 MiB binary (crypto_box with salsa20, poly1305, blake2; gpui already carried the notification code).
- Idle RSS within noise: -0.3 / -0.3 / -0.7 MiB.
- Cold start median -1.0 ms (warm), +1.8 ms (evicted); input latency medians -0.5 / +0.3 / +0.1 ms; scroll
  62.2 fps, worst frame 28.3 ms (earlier sections: 23.5-27.1 ms). The bench screen doesn't draw the inbox, and the
  notification check runs once per hub frame and every 3 s, so we read all of it as run-to-run noise.

## Linux (forge): GPU (RADV)

Pending: `wynn` is not in the `render`/`video` groups yet (`getent group render` shows no members). Once
it is, run with the GPU's Vulkan driver from the sysroot:

```sh
sg video -c "sg render -c 'FLEETD_VK_ICD=$HOME/src/fleetd-lab/sysroot/usr/share/vulkan/icd.d/radeon_icd.json app/bench/run.sh'"
```

Not tried: whether RADV can present to Xvfb, which has no DRI3. If it can't, run the same command against
a real or nested X server.

## macOS

Pending: run [MAC-RUN.md](MAC-RUN.md).

## Method

- **Build**: `--release` with Zed's profile (thin LTO, 1 codegen unit), stripped. gpui's `profiler`
  feature is on, as it is in Zed. Bench code is compiled in but only runs when `FLEETD_BENCH` is set.
- **Timestamps**: gpui's profiler journal records an exact `Instant` for every newly drawn frame and
  its present (`present_end` = the platform's present call returned). The app maps those to wall-clock
  time and the driver compares against its own clock taken just before `spawn`.
- **Cold start** = driver's spawn to the end of the first present that gpui counts for a visible
  window. gpui drops the very first frame's present, because that frame is drawn before the window
  maps; the cold-start figure therefore is the second drawn frame, which is the first the user sees.
  "Warm cache" follows one discarded run. "Evicted" calls `posix_fadvise(DONTNEED)` on the binary and
  every file it had mapped, before each run. Pages other processes are using (e.g. libc) stay resident,
  so this is "cold for our files", not "after a reboot". A true cold cache needs root
  (`drop_caches`), which we don't have.
- **Idle RSS** = `VmRSS` 10 s after the first frame. "Empty log" starts with no history and no stream.
- **Input latency, in-app** = from our key handler running to the end of the present of the first frame
  whose draw began after it. The draw can't start until the handler returns, so that frame contains the
  echo. It is measured for keys sent through gpui's `dispatch_keystroke` (all platforms) and for real X
  key events sent through XTEST. Out of each 40 letters typed, the input is cleared with an Enter, which
  isn't counted.
- **Input latency, external** (X11 only) = from the driver sending an XTEST key to the moment the input
  bar's pixels, read back with `GetImage`, differ. The driver polls without sleeping. This covers the
  whole path a user sees.
- **Scroll** = the log's scroll offset is advanced at 2400 px/s for 5 s while new lines keep streaming.
  We count presented frames and the longest gap between presents, including both window edges.
- **Focus**: without a window manager, Xvfb never focuses the window, so the driver sets X input focus
  (as a WM would). In bench mode the app also lifts gpui's 30 fps cap for unfocused windows.
