# Contributing

## Layout

fleetd is TypeScript on Bun, and the desktop and phone apps. The shipped `fleetd` is one file from
`bun build --compile`: the hub, the node and the CLI.

- `fleetd/`: fleetd itself; its README says how to build, test and run it. `src/hub/` holds the MCP endpoint, app
  socket, leads, merge train, ledger and the rest; `src/node/` is the per-machine sidecar that runs the agents;
  `src/cli/` is setup, `update`, the human commands and `agent-mcp`, the agents' tools.
- `fleetd/src/node/runner`: drives the `claude` CLI over stream-json; each session runs under a host of its own
  (`fleetd session-host`, `runner/host/`) that outlives the node. Claude's stream-json output is not a stable public
  API, so the runner accepts a pinned `claude` version range, and fixture tests
  (`fleetd/test/fixtures/runner/claude-<version>-*.jsonl`) hold it to recorded output. Widening the range may mean
  re-recording the fixtures in the same PR.
- `app/desktop/src/shared/contracts/`: the wire contract, everything that crosses a wire between fleetd's parts and the
  apps: the TypeScript types (`contracts.ts`), which the hub, the node and both apps import, and the JSON Schemas
  (`schema/`), which the hub decodes calls with and the app's fixtures are checked against. Both are kept by hand: a
  change edits both, and `fleetd/test/contracts.test.ts` fails while they disagree. An enum a newer hub may extend is
  `"x-open": true` in its schema and `Known<Name> | (string & {})` in TypeScript, so an app also admits values it
  doesn't know yet.
- `app/desktop`: the desktop app, Electron + React (see below). Its own pnpm workspace.
- `app/mobile`: the phone app (Expo); its README says how to try it on the agents' Mac's simulator, and
  `scripts/phone-lab.sh up` gives it a seeded throwaway hub to pair with.
- `tests/lab`: the factory lab (`factory/`, offline, in CI), and the tools that record claude's fixtures, the site's
  captures and the demo. `tests/compare`: black-box tests and benchmarks of two builds side by side.
- `site/` and `.github/release/`: the `fleetd.sh` installer and site, and the release pipeline. `docs/site/` is
  the docs' Starlight site, built into `site/docs/` by the Vercel build; `fleetd/scripts/docs.ts` writes its generated
  pages.

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
CI runs. Run it after your last commit and rebase: it checks the worktree against `origin/main` as it fetches it then,
so a migration main gained since, a stale generated file, a fixture with no answer for a screen's new call, or the
host name in a new file fails there instead of in CI.

A fleetd writer can't push a tree it hasn't passed on (`.fleetd/pre-push.json`): a pass records the tree it checked,
so commit exactly that. Its last line says how it went: `check.sh: pushable <tree>`, or `check.sh: failed <checks>`.
Too long for one command: start `scripts/check.sh --background`, then wait with Claude's Monitor tool running
`scripts/check.sh --wait`, which prints that last line once the run ends (never a sleep loop). The tree passes once
every check its changes touch has passed on it, in one run or several, so after a failure rerun only that check
(`scripts/check.sh fleetd`). A check's pass holds for any tree with the same inputs for it (`scripts/check.sh
--keys` prints each one's hash), so a desktop fix on a branch whose fleetd check passed doesn't run it again.

## The site

`site/` is fleetd.sh and its docs: `site/README.md` says how to build, capture and check them.

## The merge train's checks

The train waits for the checks `main` requires and the jobs `.fleetd/train.json` lists; `ci.yml`'s, `fleetd.yml`'s and
`mac.yml`'s comments say which run where.

## Hub migrations

Each change to the hub's database is one new SQL file in `fleetd/src/hub/store/migrations/`, named for the
current UTC time: `YYYYMMDDHHMM_snake_case_name.sql` (`date -u +%Y%m%d%H%M`), opening with `--` comment lines on
what it does. `bun run gen` lists them in prefix order in `src/gen/migrations.ts`, and fails on two with one prefix. A hub records each one it ran by
name with its file's SHA-256 (`migrations_applied`) and runs every one it hasn't, so a file that sorts before one a hub
already ran still runs there; one that changed after it ran never runs again, and the hub warns at its start. Never
edit, rename or remove a file that is on main: CI checks that a PR only adds files, each sorting after every one on
main, so every hub runs them in the order a fresh one does; `scripts/check.sh` runs the same check on your worktree merged
onto a fresh `origin/main`. After a rebase onto a newer migration, rename yours to a later time (the merge train does it
for you).

## Conventions

- TypeScript on Bun, checked with tsc-rs (`bun run typecheck`).
- fleetd never calls a model or usage API directly; Claude runs only through the `claude` CLI.
- Tests cover real logic and observable behaviour, not wiring, and don't sleep or poll.
- Conventional commit titles in plain language (`feat(hub): ...`, `fix(node): ...`), one branch per PR.
- No secrets in commits, logs or PR text.
