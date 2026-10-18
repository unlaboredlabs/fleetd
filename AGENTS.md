# fleetd

fleetd is a software factory: a hub that drives stock, version-pinned T3 Code daemons as an
ordinary client of their WebSocket RPC, a `fleetd node` sidecar per machine, a `fleetd` CLI,
and a GPUI desktop app, the only human surface. Claude is reached only through the `claude` CLI via T3.

## Layout

One Cargo workspace at the root; the shipped `fleetd` is one static binary with no Node in it.

- `crates/fleetd` - the binary: `hub/` (MCP endpoint, app socket, leads, train, ledger, ...), `node/` (the
  per-machine sidecar), `cli/` (setup, `update` and the lead-side commands). Its subcommands, wire shapes and SQLite
  schema match the TypeScript fleetd it replaced, so an old hub's database opens unchanged.
- `crates/fleetd-contracts` - serde types shared by the binary and the app. Anything that crosses a wire between
  fleetd components is defined here. `cargo run -p fleetd-contracts --bin fleetd-schema` rewrites the committed JSON
  Schemas in `schema/`; a test fails while they are out of date.
- `crates/t3-wire` - Rust client for the T3 WebSocket RPC methods fleetd uses. `cargo xtask t3-conformance --t3
  <checkout>` checks it against T3's own contracts at the pin.
- `vendor/t3/pin.json` - the pinned T3 release: the commit and the npm version built from it. The binary bakes it in
  (`machine add` installs that npm version, the doctor holds machines to it) and the lab runs T3 from source at that
  commit. The pin must be a published release (a commit with a `v<version>` tag); bump both fields together.
- `playbooks/` - the built-in playbooks, embedded in the binary.
- `app/` - the desktop app (`fleetd-app`, GPUI pinned to a Zed release tag) and its speed harness (`app/bench/`, run
  `app/bench/run.sh`). Building on Linux needs GPUI's `-dev` packages; without sudo, `app/bench/linux-sysroot.sh`
  extracts them and `source app/bench/linux-env.sh` points cargo at them. On macOS,
  `app/packaging/macos-bundle.sh` wraps it in `fleetd.app`, which notifications need.
- `tests/lab` - the end-to-end lab suite (Node, because the lab's T3 is a Node app): two disposable stock T3
  instances, a hub and two nodes, driven through a real MCP client. Never run in CI.
- `site/` and `.github/release/` - the `fleetd.sh` installer and the release pipeline.

## Safety rules

1. Never connect to, stop, restart or reconfigure a T3 server you did not start, and never read or
   write a live T3 home (`~/.t3/userdata`). Test against disposable T3 instances with their own
   `--home-dir` and ports.
2. Never kill by pattern (`pkill -f`, `killall`, `pgrep | kill`). Kill only PIDs you captured at
   spawn, or the owner of a port you started (check `ss -H -ltnp` and `/proc/<pid>/cwd`).
3. Start child T3/`claude` processes with a scrubbed environment: drop inherited `CLAUDE*` variables.
4. fleetd never calls a model API or a usage API directly. Real `claude` turns in tests cost the
   user's quota: tiny prompts, a handful of turns, cheap models.
5. No sudo, no global installs, no secrets in commits, logs or PR text.

## Checks

```sh
cargo fmt --all --check
cargo clippy --workspace --exclude fleetd-app --exclude fleetd-bench --all-targets -- -D warnings
cargo test --workspace --exclude fleetd-app --exclude fleetd-bench
cargo clippy -p fleetd-app -p fleetd-bench --all-targets && cargo test -p fleetd-app -p fleetd-bench   # the GPUI app, separately as in CI
```

The app's seal interop test opens what Rust seals with libsodium from `tests/lab` (`npm ci --prefix tests/lab`).
Run the checks for what you touched; CI runs all of them on every PR.

The lab suite (real T3, a handful of tiny haiku turns) runs the release binary unless `FLEETD_BIN` says otherwise.
Use your own `FLEETD_LAB_SLOT` (0-9) so runs don't collide, and name scenarios to run only those:

```sh
cargo build --release -p fleetd && npm ci --prefix tests/lab
FLEETD_LAB_SLOT=7 npm --prefix tests/lab run lab -- m1
```

## Conventions

- Rust edition 2024, no `unsafe`. `crates/fleetd` must not link macOS frameworks: the darwin binaries are
  cross-built on Linux (CI job `darwin-deps`).
- `tests/lab` is TypeScript run directly by Node >= 24: relative imports with `.ts` extensions, erasable syntax only
  (`npm --prefix tests/lab run typecheck`).
- Tests cover real logic and observable behaviour, not wiring. No sleeps or polling in tests.
- One worktree and branch per PR; never commit to `main`. Conventional commit titles in plain
  language (`feat(hub): ...`, `fix(node): ...`).
- Build the smallest thing that meets the task. No speculative abstractions.
