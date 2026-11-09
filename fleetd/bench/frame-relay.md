# Live-screen frame relay: Rust hub against Bun

`bun bench/frame-relay.ts rust|bun`: one node streams a browser session's frames (300 frames of 60 KB JPEG-sized
base64 at 30 fps), 100 app connections watch it, the hub relays every frame to every one. Each run is on a fresh home
under `$TMPDIR` (FLEETD_HOME there, a free loopback port). Hub CPU is the hub process's utime + stime over the stream,
less its own over an idle window as long; latency is node send to watcher receipt, on loopback. Devbox, 2026-11-08,
three runs each (the middle one shown; all three within 5%).

| Hub | Delivered | Hub CPU | CPU per delivery | p50 | p99 | Peak RSS |
|---|---|---|---|---|---|---|
| Rust (`fleetd hub start`, the installed release build) | 30000 / 30000 | 8.36 s (72.7% of a core) | 279 µs | 3.3 ms | 5.8 ms | 77 MB |
| Bun, each watcher serializing the frame (as the Rust hub does) | 30000 / 30000 | 1.22 s (10.6%) | 41 µs | 1.9 ms | 4.2 ms | 74 MB |
| Bun, the frame's text made once for every watcher | 30000 / 30000 | 0.70 s (6.1%) | 23 µs | 1.7 ms | 4.0 ms | 54 MB |
| Bun as shipped: the same, through the Bun hub's real `/node/link` (#1175) | 30000 / 30000 | 0.62 s (5.4%) | 21 µs | 1.4 ms | 3.6 ms | 62 MB |

What each side runs: the Rust hub is the whole binary (its node link, /app with auth, the browser area's watch and
pacing slot). The Bun side is `bench/relay-bun-hub.ts`: the Bun hub's real node link (challenge, signed hello, frame
dispatch) and `src/hub/browser` (Live, each connection's slot and pace, the Only-me check per frame), with a stand-in
for `/app` until that area lands, which takes `auth` without a key lookup; the Rust hub checks the key once per
connection and on its recheck tick, not per frame. The first two Bun rows ran with the link stood in too. Neither
watcher acks, so neither paces. The Rust hub's cost is mostly serializing the 80 KB frame again for each watcher
(`serde_json::to_value` then `to_string`, in app_ws); serializing it once per frame would close most of the gap there.
