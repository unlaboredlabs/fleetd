# Contributing

## Layout

fleetd is one Cargo workspace. The shipped `fleetd` is one static binary with no Node in it.

- `crates/fleetd`: the binary. `hub/` holds the MCP endpoint, app socket, leads, merge train, ledger and the rest;
  `node/` is the per-machine sidecar that runs the agents; `cli/` is setup, `update` and the lead-side commands. The
  hub's SQLite schema matches the TypeScript fleetd it replaced, so an older hub's database opens unchanged.
- `crates/fleetd/src/node/runner`: drives the `claude` CLI over stream-json. Claude's stream-json output is not a
  stable public API, so the runner accepts a pinned `claude` version range, and fixture tests
  (`runner/fixtures/claude-<version>-*.jsonl`) hold it to recorded output. Widening the range may mean
  re-recording the fixtures in the same PR.
- `crates/fleetd-contracts`: serde types for everything that crosses a wire between fleetd components, shared by the
  binary and the app. `cargo run -p fleetd-contracts --bin fleetd-schema` rewrites the committed JSON Schemas in
  `schema/` and the desktop app's TypeScript in `app/desktop/src/shared/contracts/generated/`; a test and a CI step
  (`fleetd-schema --check`) fail while either is out of date or hand-edited. A Rust enum a newer hub may extend gets
  `#[schemars(extend("x-open" = true))]`, so the app's type also admits values it doesn't know yet.
- `playbooks/`: the built-in playbooks, embedded in the binary.
- `app/`: the desktop app (`fleetd-app`, GPUI pinned to a Zed release tag) and its speed harness (`app/bench/`, run
  with `app/bench/run.sh`).
- `app/desktop`: the Electron + React app replacing `fleetd-app` (see below). Its own pnpm workspace, outside Cargo.
- `tests/lab`: the end-to-end lab suite.
- `site/` and `.github/release/`: the `fleetd.sh` installer and site, and the release pipeline. `docs/site/` holds
  the docs' sources and `crates/docsgen` renders them into `site/docs/`.

## Building the app

On Linux the app needs GPUI's `-dev` packages. Without root, `app/bench/linux-sysroot.sh` extracts them and
`source app/bench/linux-env.sh` points cargo at them. On macOS, `app/packaging/macos-bundle.sh` wraps the binary in
`fleetd.app`, which notifications need.

## The Electron app

`app/desktop` needs Node 24 and pnpm (the version in its `package.json`). In that directory: `pnpm install`, then
`pnpm dev` (hot reload), `pnpm build` and `pnpm start` (the built app), and `pnpm typecheck`, `pnpm lint` and
`pnpm test`, which CI's `desktop` job runs. Electron downloads its binary on first launch. `npm --prefix tests/lab
run lab -- desktop` (after `pnpm build:test`) drives the built app against a lab hub: auth, snapshot, events, calls, live,
liveness, reconnect and pairing.

`FLEETD_HUB_URL` + `FLEETD_AGENT_KEY` connect for one run without saving anything; `FLEETD_HOME` moves every file the
app keeps (the saved key, the migration marker) and keeps it off the OS keychain; `FLEETD_FIXTURE=<name>` replaces the
hub with `fixtures/<name>.json` (or an absolute path; `FLEETD_FIXTURE_DIR` moves the directory) and shows a
"Sample data" banner; a release build ignores it unless `FLEETD_DEV_FIXTURES=1` is set too.

`pnpm build` makes the release build, which refuses to start with `--remote-debugging-*` or `--inspect*`.
`pnpm build:test` (and `pnpm qa:build`) set `MAIN_VITE_FLEETD_TEST_BUILD=1`, which is inlined at build time, for
DevTools-driven tests; never ship one. `pnpm debug-guard-check` checks both.

- `src/main`: the Electron main process. It holds the one hub connection and the saved key; the renderer has no
  network (its CSP has `connect-src 'none'`).
- `src/preload`: `window.fleetd`, the only bridge. `src/preload/api.d.ts` is its type.
- `src/shared`: the IPC channels (`channels.ts`) and the schema main checks every renderer request against
  (`ipc.ts`). A new channel goes in both, then in `src/main/ipc.ts` and the preload.
- `src/renderer`: the React app.
- Releases: `electron-builder.yml` packs the built app (a universal, Developer ID-signed `fleetd.app`, an AppImage and
  a deb) in `build-release.yml`'s `desktop-*` jobs, which run while the repo variable `FLEETD_RELEASE_DESKTOP` is
  `true` or a dispatch of Nightly asks for them. The app updates itself from `latest-mac.yml` / `latest-linux.yml` on
  the release (`src/main/updater.ts`); `FLEETD_APP=electron` makes the installer fetch it.

## Checks

```sh
cargo fmt --all --check
cargo clippy --workspace --exclude fleetd-app --exclude fleetd-bench --all-targets -- -D warnings
cargo test --workspace --exclude fleetd-app --exclude fleetd-bench
cargo clippy -p fleetd-app -p fleetd-bench --all-targets -- -D warnings && cargo test -p fleetd-app -p fleetd-bench
```

The app's seal test opens what Rust seals with libsodium from `tests/lab`, so run `npm ci --prefix tests/lab` first.
CI runs all of these on every PR.

`crates/fleetd` must not link macOS frameworks, because the darwin binaries are cross-built on Linux. The
`darwin-deps` CI job checks this: rusqlite takes only named features such as `bundled`, chrono has no `clock`, and
TLS uses webpki roots.

## Lab suite

The lab runs the release binary end to end: a hub and two nodes, driven through a real MCP client. Each node is a
`fleetd node` with its own HOME under the lab directory, so it has its own `~/.fleetd` and its own `~/.claude`,
which its sessions use as a real machine's sessions use the user's. The lab copies your `claude` login material into
it (the login variables and `apiKeyHelper` from `~/.claude/settings.json`, and `.credentials.json` if you have one),
deletes the copies when the run ends, and never writes under your real `~/.claude` or `~/.fleetd`. It isn't run in CI. It costs a
handful of small `claude` haiku turns, and needs Node 24 or newer to run its TypeScript. The m7 and m9 scenarios also
use your `gh` login and a public testbed repository.

```sh
cargo build --release -p fleetd && npm ci --prefix tests/lab
FLEETD_LAB_SLOT=7 npm --prefix tests/lab run lab -- m1   # name scenarios, or none for the full suite
```

`FLEETD_LAB_SLOT` (0-9) gives each run its own directory and ports, so parallel runs don't collide. Each slot has its
own testbed repository too (`unlaboredlabs/fleetd-testbed-N`; slots 0 and 9 share `unlaboredlabs/fleetd-testbed`;
`FLEETD_TESTBED` overrides), so merge-train scenarios run in parallel as well. Create one, with its clone, using
`node tests/lab/testbed.ts --repo unlaboredlabs/fleetd-testbed-N --clone ~/src/fleetd-lab/slot-N/testbed`. `FLEETD_BIN`
picks another binary. The lab stops only the processes it started, so it is safe to run next to a fleetd you use day
to day.

`tests/lab` is TypeScript run directly by Node: relative imports with `.ts` extensions and erasable syntax only
(`npm --prefix tests/lab run typecheck`).

## The site

`site/` is fleetd.sh: the landing page and the docs at `/docs`, generated from `docs/site/*.md` by `crates/docsgen`
(`cargo run -q -p docsgen`, then commit `site/docs`; CI fails while it is out of date). The site shows real app
screenshots and real setup output. A change that alters what the app shows or what `fleetd
init` or `fleetd machine add` prints reruns `tests/lab/site-capture.ts` and commits the updated `site/` in the same
PR (see `site/README.md`); `node tests/lab/site-capture.ts --docs` recaptures only the docs' output blocks. A change
that removes something the site mentions adds it to `site/.stale-terms`, which CI checks the page and the docs'
sources against. A new or renamed command shows up in the docs' CLI reference by itself.

## Conventions

- Rust edition 2024, no `unsafe`.
- fleetd never calls a model or usage API directly; Claude runs only through the `claude` CLI.
- Tests cover real logic and observable behaviour, not wiring, and don't sleep or poll.
- Conventional commit titles in plain language (`feat(hub): ...`, `fix(node): ...`), one branch per PR.
- No secrets in commits, logs or PR text.
