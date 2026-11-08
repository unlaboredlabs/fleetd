# experimental/compare

Side-by-side tests and benchmarks of fleetd implementations: the Rust build today, the Bun one
(`experimental/bun`, `bun build --compile`) once it builds. Each one is a black box, a binary given by `FLEETD_BIN`
(or `--bin`), started and measured from outside, so both run the same scripts. Nothing here changes how fleetd
behaves; the Rust integration tests that run the binary read `FLEETD_BIN` too, and default to their own build as before.

Setup, once: `npm ci` here and in `tests/lab` (the factory lab's kit is the fleet every bench starts); for the
desktop QA, `pnpm install && pnpm qa:build` in `app/desktop`. Node 24.

| script | what | writes |
|---|---|---|
| `node behaviour.ts --impl rust --impl bun=<bin>` | the factory lab's scenarios, `crates/fleetd/tests`' binary tests (closed_pipe, home_isolation, session_host) and `contract.ts`, pass/fail side by side, and what one surface (MCP tools, `ready`'s features, snapshot keys) has that the other lacks | `behaviour.json` |
| `node contract.ts` | every frame and tool answer the apps read, checked against `crates/fleetd-contracts/schema` | (part of behaviour) |
| `node desktop.ts` | the desktop app's QA build on a live hub of the binary: 20 screens (QA's own state, liveness and DOM checks), a chat answered by the lead, a spawned writer in the agents panel | `desktop.json` |
| `node build.ts --impl rust [--jobs N]` | clean and one-file-edit build, check and test build times, and the test suite's run, from `impls.json`, on N pinned CPUs (default 2) with every tool's parallelism set to N | `build-j<N>.json` |
| `node bench.ts [size startup hub-ready idle sessions fanout sql weaknet]` | the runtime numbers (each bench's header comment says how it measures) | `<bench>.json` |
| `node soak.ts [--minutes 60]` | an hour of steady work: serving stalls over 100 ms, RSS growth, CPU | `soak.json` |
| `node report.ts rust bun --out report.md` | two result sets as one markdown table | |

`--impl <name>` names the results directory (`results/<name>/`, default `rust`); its binary is `impls.json`'s `bin`
unless `--bin` or `FLEETD_BIN` gives one. `--out <dir>` (or `COMPARE_OUT`) writes results elsewhere.

Rules the scripts keep, and a run by hand should too:

- Every hub is a throwaway: its own `FLEETD_HOME`, HOME and port under `$TMPDIR/fleetd-compare/`, never the real hub or
  its database. `bench.ts sql` fills a hub that a bench run just made, never a copy of a real one.
- Processes are stopped by the PID captured at spawn, never by name.
- Builds of both sides run on the same N CPUs (`taskset`), with `CARGO_BUILD_JOBS`, `MAKEFLAGS` and
  `RUST_TEST_THREADS` set to N whatever the caller's environment says, and every row records N. Rust builds go
  through the machine's build slots: `build.ts` reports cargo's own time ("Finished … in"), which leaves the wait out. Numbers only compare within one machine and one load: each result records the load average.

`results/rust/` is the committed baseline. To compare: build the Bun binary, run the same scripts with
`--impl bun`, then `node report.ts rust bun`. `results/bun/behaviour.json` is the Bun build's run on main `aa0abbd6e`:
every suite passes, 57 of 57 rows, all-Bun fleet (with `bun run helper`'s session-host beside it).
