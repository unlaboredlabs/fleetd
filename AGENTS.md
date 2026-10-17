# fleetd

fleetd is a software factory: a hub that drives stock, version-pinned T3 Code daemons as an
ordinary client of their WebSocket RPC, a `fleetd node` sidecar per machine, a `fleetd` CLI,
and a GPUI desktop app, the only human surface. Claude is reached only through the `claude` CLI via T3.

## Layout

- `packages/contracts` - Effect Schema types shared by hub, node, CLI and app. Anything that crosses
  a wire between fleetd components is defined here.
- `apps/hub`, `apps/node`, `apps/cli` (bin `fleetd`) - TypeScript, Effect 4.
- `vendor/t3/` - generated slice of T3's `contracts`, `client-runtime` and `shared` at the commit in
  `vendor/t3/pin.json`. **Never edit by hand.** To use more of T3, add an entry to `ENTRIES` in
  `scripts/sync-t3.ts` and run `pnpm sync:t3 --source <t3 checkout>`. The pin must be a published
  release (`--pin <commit with a v<version> tag>`): `pin.json` records the commit and its npm version,
  which the hub, setup, the doctor and the lab all read. Keep the `effect`/`typescript` catalog
  versions in `pnpm-workspace.yaml` in step with the pin.
- `app/` - Cargo workspace for the desktop app (`fleetd-app`, GPUI pinned to a Zed release tag) and
  its speed harness (`app/bench/`, run `app/bench/run.sh`). Building on Linux needs GPUI's `-dev`
  packages; without sudo, `app/bench/linux-sysroot.sh` extracts them and `source app/bench/linux-env.sh`
  points cargo at them. On macOS, `app/macos-bundle.sh` wraps it in `fleetd.app`, which notifications need.

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
pnpm install
pnpm typecheck   # scripts + every workspace package, vendored T3 included
pnpm lint        # oxlint
pnpm test        # vitest per package
pnpm build       # rolldown bundles into apps/*/dist
cargo clippy --workspace --all-targets && cargo test --workspace   # crates/*, the GPUI app and its bench
```

Run the checks for what you touched; CI runs all of them on every PR.

## Conventions

- Node >= 24, pnpm via `packageManager`. TypeScript strict, source-first packages (exports point at
  `src/*.ts`), relative imports with `.ts` extensions, erasable syntax only.
- Tests cover real logic and observable behaviour, not wiring. No sleeps or polling in tests.
- One worktree and branch per PR; never commit to `main`. Conventional commit titles in plain
  language (`feat(hub): ...`, `fix(node): ...`).
- Build the smallest thing that meets the task. No speculative abstractions.
