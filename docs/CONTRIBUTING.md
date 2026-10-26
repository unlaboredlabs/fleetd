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
- `tests/lab`: the end-to-end lab suite.
- `site/` and `.github/release/`: the `fleetd.sh` installer and site, and the release pipeline. `docs/site/` is
  the docs' Starlight site, built into `site/docs/`; `crates/docsgen` writes its generated pages.

## The desktop app

`app/desktop` needs Node 24 and pnpm (the version in its `package.json`). In that directory: `pnpm install`, then
`pnpm dev` (hot reload), `pnpm build` and `pnpm start` (the built app), and `pnpm typecheck`, `pnpm lint` and
`pnpm test`, which CI's `desktop` job runs. Electron downloads its binary on first launch. `npm --prefix tests/lab
run lab -- desktop` (after `pnpm build:test`) drives the built app against a lab hub: auth, snapshot, events, calls, live,
liveness, reconnect and pairing. `run lab -- desktop-offline` drives its window through a hub stop, a quit and a restart: the
chat kept on screen, a message queued offline and sent once.

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

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The node's seal test opens what Rust seals with libsodium from `tests/lab`; without `npm ci --prefix tests/lab` it
skips that half. CI runs all of these on every PR, and the desktop app's checks above.

`crates/fleetd` must not link macOS frameworks, because the darwin binaries are cross-built on Linux. The
`darwin-deps` CI job checks this: rusqlite takes only named features such as `bundled`, chrono has no `clock`, and
TLS uses webpki roots.

## Lab suite

The lab runs the release binary end to end: a hub and two nodes, driven through a real MCP client. Each node is a
`fleetd node` with its own HOME under the lab directory, so it has its own `~/.fleetd` and its own `~/.claude`,
which its sessions use as a real machine's sessions use the user's. The lab copies your `claude` login material into
it (the login variables and `apiKeyHelper` from `~/.claude/settings.json`, and `.credentials.json` if you have one),
deletes the copies when the run ends, and never writes under your real `~/.claude` or `~/.fleetd`. It isn't run in CI. Mechanics
scenarios run small `claude` turns on `claude-opus-5-5` at medium effort. Behaviour scenarios run the lead (and, in `eff`, the writer)
on the model fleetd ships, `claude-opus-5-5` at high effort, because the prompts are written for it: the `chat` lead,
`steer`, and `eff`'s slices. The lab needs Node 24 or newer to run its TypeScript. The m7, m9, time and
demo scenarios also use your `gh` login and the public lab repository `unlaboredlabs/fleetd-lab`.

```sh
cargo build --release -p fleetd && npm ci --prefix tests/lab
FLEETD_LAB_SLOT=7 npm --prefix tests/lab run lab -- m1   # name scenarios, or none for the full suite
```

`FLEETD_LAB_SLOT` (0-9) gives each run its own directory and ports, so parallel runs don't collide. Every slot shares
the one lab repository and works in its own branch namespace: slot N's train merges into `slot/N/main`, and its task
branches are `slot/N/fleetd/...` (the lab writes `branchPrefix` into the project's untracked policy file). Before and
after a run the lab closes the namespace's open PRs, deletes its branches and resets `slot/N/main` to the `seed` tag;
it never touches another namespace or the repository's `main` (the demo closes only the PRs and branches it made). A
run leases its namespace with the branch `lease/<namespace>` for up to 4 hours and drops it on exit, so a second run on
a busy namespace, from any worktree or machine, stops and says which run holds it; an expired lease is taken over. `FLEETD_LAB_REPO` picks
another repository. Set one up, with its clone, using `node tests/lab/labRepo.ts --repo <owner/name> --clone
~/src/fleetd-lab/slot-N/lab-repo`: it never creates the repository, and it adds the rulesets (`slot/*/main` requires
the `ci` check and the `fleetd/train` status, `noci/*/main` only `fleetd/train`, squash merges only). Repository
admins may bypass those rulesets, and they have no deletion or force-push rule, so the lab can reset a namespace's main;
that holds for the lab repository only. `FLEETD_BIN` picks another binary. The lab stops only the processes it
started, so it is safe to run next to a fleetd you use day to day.

`tests/lab` is TypeScript run directly by Node: relative imports with `.ts` extensions and erasable syntax only
(`npm --prefix tests/lab run typecheck`).

## The site

`site/` is fleetd.sh: the landing page and the docs at `/docs`, built from `docs/site/` with Starlight
(`npm run build --prefix docs/site`, then commit `site/docs`; CI fails while it is out of date). Its search index,
`site/docs/pagefind`, is ignored, not committed: the Vercel build generates it. The site shows real app
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
