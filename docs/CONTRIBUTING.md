# Contributing

## Layout

fleetd is one Cargo workspace and the desktop app. The shipped `fleetd` is one static binary with no Node in it.

- `crates/fleetd`: the binary. `hub/` holds the MCP endpoint, app socket, leads, merge train, ledger and the rest;
  `node/` is the per-machine sidecar that runs the agents; `cli/` is setup, `update`, the human commands and
  `agent-mcp`, the agents' tools. The hub's SQLite schema matches the TypeScript fleetd it replaced, so an older hub's
  database opens unchanged.
- `crates/fleetd/src/node/runner`: drives the `claude` CLI over stream-json. Claude's stream-json output is not a
  stable public API, so the runner accepts a pinned `claude` version range, and fixture tests
  (`runner/fixtures/claude-<version>-*.jsonl`) hold it to recorded output. Widening the range may mean
  re-recording the fixtures in the same PR.
- `crates/fleetd-contracts`: serde types for everything that crosses a wire between fleetd components, shared by the
  binary and the app. `cargo run -p fleetd-contracts --bin fleetd-schema` rewrites the committed JSON Schemas in
  `schema/` and the desktop app's TypeScript in `app/desktop/src/shared/contracts/generated/`; a test
  (`schema::generated_contracts_are_current`) fails while either is out of date or hand-edited. A Rust enum a newer
  hub may extend gets `#[schemars(extend("x-open" = true))]`, so the app's type also admits values it doesn't know
  yet.
- `app/desktop`: the desktop app, Electron + React (see below). Its own pnpm workspace, outside Cargo.
- `tests/lab`: the factory lab (`factory/`, offline, in CI), and the tools that record claude's fixtures, the site's
  captures and the demo.
- `site/` and `.github/release/`: the `fleetd.sh` installer and site, and the release pipeline. `docs/site/` is
  the docs' Starlight site, built into `site/docs/` by the Vercel build; `crates/docsgen` writes its generated pages.

## The desktop app

`app/desktop` needs Node 24 and pnpm (the version in its `package.json`). In that directory: `pnpm install`, then
`pnpm dev` (hot reload), `pnpm build` and `pnpm start` (the built app), and `pnpm typecheck`, `pnpm lint` and
`pnpm test`, which CI's `desktop` job runs. Electron downloads its binary on first launch.

`FLEETD_HUB_URL` + `FLEETD_AGENT_KEY` connect for one run without saving anything; `FLEETD_HOME` moves every file the
app keeps (the saved key, the migration marker) and keeps it off the OS keychain; `FLEETD_FIXTURE=<name>` replaces the
hub with `fixtures/<name>.json` (or an absolute path; `FLEETD_FIXTURE_DIR` moves the directory) and shows a
"Sample data" banner; a release build ignores it.

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
  a deb) in `build-release.yml`'s `desktop-*` jobs. The app updates itself from `latest-mac.yml` / `latest-linux.yml`
  on the release (`src/main/updater.ts`), and `fleetd update` reads the same feed.

## Checks

Before every push, run `scripts/check.sh`; its header says what each check runs, and `ci.yml`'s comments say what
CI runs.

`crates/fleetd` must not link macOS frameworks, because the darwin binaries are cross-built on Linux. The
`darwin-deps` CI job checks this: rusqlite takes only named features such as `bundled`, chrono has no `clock`, and
TLS uses webpki roots.

## The site

`site/` is fleetd.sh and its docs: `site/README.md` says how to build, capture and check them.

## The merge train's checks

The train waits for the checks `main` requires and the jobs `.fleetd/train.json` lists; `ci.yml`'s and `mac.yml`'s
comments say which run where.

## Hub migrations

Each change to the hub's database is one new SQL file in `crates/fleetd/src/hub/store/migrations/`, named for the
current UTC time: `YYYYMMDDHHMM_snake_case_name.sql` (`date -u +%Y%m%d%H%M`), opening with `--` comment lines on
what it does. The build runs them in prefix order and fails on two with one prefix. A hub records each one it ran by
name with its file's SHA-256 (`migrations_applied`) and runs every one it hasn't, so a file that sorts before one a hub
already ran still runs there; one that changed after it ran never runs again, and the hub warns at its start. Never
edit, rename or remove a file that is on main: CI checks that a PR only adds files, each sorting after every one on
main, so every hub runs them in the order a fresh one does. After a rebase onto a newer migration, rename yours to a
later time (the merge train does it for you).

## Conventions

- Rust edition 2024, no `unsafe`.
- fleetd never calls a model or usage API directly; Claude runs only through the `claude` CLI.
- Tests cover real logic and observable behaviour, not wiring, and don't sleep or poll.
- Conventional commit titles in plain language (`feat(hub): ...`, `fix(node): ...`), one branch per PR.
- No secrets in commits, logs or PR text.
