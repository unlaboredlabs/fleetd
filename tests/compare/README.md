# tests/compare

Black-box tests and benchmarks of fleetd builds: each one a binary given by `FLEETD_BIN` (or `--bin`, by default
`fleetd/dist/fleetd` from `bun run compile`), started and measured from outside, so two builds (main and a branch, say)
run the same scripts side by side. Nothing here changes how fleetd behaves.

Setup, once: `npm ci` here and in `tests/lab` (the factory lab's kit is the fleet every bench starts); for the
desktop QA, `pnpm install && pnpm qa:build` in `app/desktop`. Node 24 and Bun.

| script | what | writes |
|---|---|---|
| `node behaviour.ts [--impl <name>[=<bin>]]…` | the factory lab's scenarios, fleetd's black-box tests (`fleetd/test/blackbox`, the session host's) and `contract.ts`, pass/fail side by side, and what one surface (MCP tools, `ready`'s features, snapshot keys) has that the other lacks | `behaviour.json` |
| `node contract.ts` | every frame and tool answer the apps read, checked against `app/desktop/src/shared/contracts/schema` | (part of behaviour) |
| `node desktop.ts` | the desktop app's QA build on a live hub of the binary: 20 screens (QA's own state, liveness and DOM checks), a chat answered by the lead, a spawned writer in the agents panel | `desktop.json` |
| `node build.ts [--jobs N]` | clean and one-file-edit build, check and test times, and the test suite's run, from `impls.json`, on N pinned CPUs (default 2) | `build-j<N>.json` |
| `node bench.ts [size startup hub-ready idle sessions fanout sql weaknet]` | the runtime numbers (each bench's header comment says how it measures) | `<bench>.json` |
| `node soak.ts [--minutes 60]` | an hour of steady work: serving stalls over 100 ms, RSS growth, CPU | `soak.json` |
| `node report.ts <a> <b> --out report.md` | two result sets as one markdown table | |

`--impl <name>` names the results directory (`results/<name>/`, default `bun`); its binary is `impls.json`'s `bin`
unless `--bin` or `FLEETD_BIN` gives one. `--out <dir>` (or `COMPARE_OUT`) writes results elsewhere.

Rules the scripts keep, and a run by hand should too:

- Every hub is a throwaway: its own `FLEETD_HOME`, HOME and port under `$TMPDIR/fleetd-compare/`, never the real hub or
  its database. `bench.ts sql` fills a hub that a bench run just made, never a copy of a real one.
- Processes are stopped by the PID captured at spawn, never by name.
- Builds run on the same N CPUs (`taskset`), and every row records N. Numbers only compare within one machine and one
  load: each result records the load average.

`results/bun/behaviour.json` is a run on main `aa0abbd6e`: every suite passes, 57 of 57 rows.
