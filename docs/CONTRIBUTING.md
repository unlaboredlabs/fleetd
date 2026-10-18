# Contributing

## Layout

fleetd is one Cargo workspace. The shipped `fleetd` is one static binary with no Node in it.

- `crates/fleetd`: the binary. `hub/` holds the MCP endpoint, app socket, leads, merge train, ledger and the rest;
  `node/` is the per-machine sidecar; `cli/` is setup, `update` and the lead-side commands. The hub's SQLite schema
  matches the TypeScript fleetd it replaced, so an older hub's database opens unchanged.
- `crates/fleetd-contracts`: serde types for everything that crosses a wire between fleetd components, shared by the
  binary and the app. `cargo run -p fleetd-contracts --bin fleetd-schema` rewrites the committed JSON Schemas in
  `schema/`; a test fails while they are out of date.
- `crates/t3-wire`: the client for the T3 WebSocket RPC methods fleetd uses. `cargo xtask t3-conformance --t3
  <checkout>` checks it against T3's own contracts at the pin.
- `vendor/t3/pin.json`: the pinned T3 release, the commit plus the npm version built from it. The binary bakes it in
  (`machine add` installs that version and the doctor holds machines to it), and the lab runs T3 from source at that
  commit. Pin only published releases (a commit with a `v<version>` tag), and bump both fields together.
- `playbooks/`: the built-in playbooks, embedded in the binary.
- `app/`: the desktop app (`fleetd-app`, GPUI pinned to a Zed release tag) and its speed harness (`app/bench/`, run
  with `app/bench/run.sh`).
- `tests/lab`: the end-to-end lab suite.
- `site/` and `.github/release/`: the `fleetd.sh` installer and the release pipeline.

## Building the app

On Linux the app needs GPUI's `-dev` packages. Without root, `app/bench/linux-sysroot.sh` extracts them and
`source app/bench/linux-env.sh` points cargo at them. On macOS, `app/packaging/macos-bundle.sh` wraps the binary in
`fleetd.app`, which notifications need.

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

The lab runs the release binary end to end against two disposable stock T3 instances, a hub and two nodes, driven
through a real MCP client. It isn't run in CI. It costs a handful of small `claude` haiku turns from your own login,
and needs Node 24 or newer (T3 is a Node app). The m7 and m9 scenarios also use your `gh` login and a public testbed
repository.

```sh
cargo build --release -p fleetd && npm ci --prefix tests/lab
FLEETD_LAB_SLOT=7 npm --prefix tests/lab run lab -- m1   # name scenarios, or none for the full suite
```

`FLEETD_LAB_SLOT` (0-9) gives each run its own directory and ports, so parallel runs don't collide. `FLEETD_BIN`
picks another binary. The lab never touches a T3 server it didn't start, so it is safe to run next to a T3 you use
day to day.

`tests/lab` is TypeScript run directly by Node: relative imports with `.ts` extensions and erasable syntax only
(`npm --prefix tests/lab run typecheck`).

## Conventions

- Rust edition 2024, no `unsafe`.
- fleetd never calls a model or usage API directly; Claude runs only through the `claude` CLI.
- Tests cover real logic and observable behaviour, not wiring, and don't sleep or poll.
- Conventional commit titles in plain language (`feat(hub): ...`, `fix(node): ...`), one branch per PR.
- No secrets in commits, logs or PR text.
