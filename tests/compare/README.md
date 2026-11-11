# tests/compare

Black-box tests and benchmarks of fleetd builds: each one a binary given by `FLEETD_BIN` (or `--bin`, by default
`fleetd/dist/fleetd` from `bun run compile`), started and measured from outside, so two builds (main and a branch, say)
run the same scripts side by side. Nothing here changes how fleetd behaves.

The behaviour suites run against a target: an address, and a way to make a team there (`target.ts`). A hub of the
build, started on a home of its own, is the target unless `--target` gives another (see Targets below).

Setup, once: `npm ci` here and in `tests/lab` (the factory lab's kit is the fleet every bench starts); for the
desktop QA, `pnpm install && pnpm qa:build` in `app/desktop`. Node 24 and Bun.

| script | what | writes |
|---|---|---|
| `node behaviour.ts [--impl <name>[=<bin>]]… [--target <module>]` | the factory lab's scenarios, fleetd's black-box tests (`fleetd/test/blackbox`, the session host's), `contract.ts` and `isolation.ts`, pass/fail side by side, and what one surface (MCP tools, `ready`'s features, snapshot keys) has that the other lacks. A skipped row says why, and the last line counts them | `behaviour.json` |
| `node factory.ts <scenario>` | one factory lab scenario (`tests/lab/factory`), its node joined to a team of the target | (part of behaviour) |
| `node contract.ts` | every frame and tool answer the apps read, checked against `app/desktop/src/shared/contracts/schema` | (part of behaviour) |
| `node isolation.ts [--two-hubs]` | the two-team cases: every tool that takes an id, called with one team's key and another team's ids | (part of behaviour) |
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

## Targets

A target (`target.ts`) is a name, how many teams it can make, and `team(dir)`, which gives a team: its address, `key`
(a new key of the team, of a role, a person's or not) and `enrol` (a join code for a machine). That is all the suites
ask of what they run against: the factory kit's node joins the team with `enrol`, and every call is made with a key
from `key`.

- `hubBuild.ts` is the target the scripts always had: a hub of the build on a home of its own. It makes one team.
- `--target <module>` (or `COMPARE_TARGET`) runs `behaviour.ts`, `factory.ts`, `contract.ts` and `isolation.ts` against
  what the module makes instead. Its default export is given the build under test and returns the target:

  ```ts
  // hosted.ts, in the service's own repo. The scripts run from a checkout of this one:
  //   node tests/compare/behaviour.ts --impl hosted --target ../hosted/hosted.ts
  import type { MakeTarget } from "../fleetd/tests/compare/hubBuild.ts";
  const make: MakeTarget = ({ name, bin }) => ({ name: "hosted", teams: Infinity, team: async (dir) => …, close: async () => … });
  export default make;
  ```

  The node that joins a team, and the CLI, are still the build's (`--bin`). The black-box tests start hubs of the
  binary themselves, so with `--target` their row is skipped. The benches (`bench.ts`, `soak.ts`, `desktop.ts`) measure
  a hub process and stay on the hub build.

## Two-team cases

`twoTeams.ts` makes the cases from the target's own `tools/list`, so a tool added to the list is covered with no case
written for it. An input schema says where an id goes: a named string type called `…Id`, `…Name`, `…Key`, `…Topic` or
`…Ref`, or a plain string property called `…Id`. For each input a tool allows there is a case with every id team B's,
and one per kind of id with the rest team A's own. Each team's ids are read with its own key, through the read-only
tools, typed by the contract's output schemas.

A case calls the tool three times with team A's key: with an id nobody holds, with team B's, with another nobody
holds. B's must get the answer the unknown ones get, once the ids sent are masked: the same error, the same shape, the
same message. What differs between the two unknown ids (a time, a number the call drew) is not held against it. And
nothing team A is told, in the cases or in its own reads, may hold a canary: a string the run puts in team B's rows.

An id is team B's while team A doesn't hold it too, and what A holds is not taken from its reads on trust: a list that
shows A team B's rows would make every id in it look shared. So team A's ids are read before team B is made
(`readIds`), and what it held then is its own. An id of B's that A's reads return afterwards fails the tool that
returned it, and is still asked about as B's. One thing is allowed for: after a call of A's that wrote, A may have
counted up to a number B also has (its own second decision is `D2`), which is A's own from then on. The read-only
tools' cases run first, before any such write.

The run prints the counts, then each failure:

- `pass`, `FAIL`;
- `weak`: the case proved little, and says why: the unknown id was itself refused as invalid input, before any
  lookup;
- not probed: tools whose ids are of kinds team B holds none of that team A lacks. `isolation.ts` gives each team a
  fleet, an order, a writer, a decision, an automation and an invite, team B two of each; a kind it seeds nothing of
  (a vault item, a browser session, an upload) is listed here, by name;
- tools that take no id;
- the ids both teams hold, team A's its own (a number each team counts, a built-in name), which tell nothing apart.

Not covered: an id that is an integer (`profile_update`'s and `profile_delete`'s `id`), and what a key of a lesser
role may do inside its own team.

They need a target that makes two teams. On one that makes one, as a self-hosted hub does, the row is skipped and says
how many cases were made and not run. Two things stand in for the missing second team here:

- `fleetd/test/compare/two_teams.test.ts` (in fleetd's own test run) proves the cases on `standIn.ts`, a small
  service with many teams at one address: they pass when it keeps its teams apart, and fail when it is told to leak (a
  row of B's returned, `forbidden` where an unknown id gets `not_found`, a list holding B's rows, a list holding B's
  ids and none of its texts). It also holds the
  cases to the hub's real tool list: every tool with an id gets one, and each input is one the hub's decoder takes.
- `node isolation.ts --two-hubs` runs them on two hubs of the build. Neither hub has heard of the other's ids, so every
  case must pass: one that fails is a fault in the cases, not in the hub.

`isolation.ts` also names a hosted service's other isolation checks (its database's policies, events across two
instances, stored vault items and objects) as rows skipped with what they need: more than a target gives.

`results/bun/behaviour.json` is a run of the hub build on main `a91b5b914`: every suite passes, 57 rows pass and 4 are
skipped (the two-team cases, 507 of them over 168 of 213 tools, and the three checks above).
