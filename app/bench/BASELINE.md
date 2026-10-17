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
