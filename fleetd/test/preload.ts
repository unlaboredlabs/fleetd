// Run before every test file (bunfig.toml). A hub's doctor runs `gh auth status` through its default command runner:
// this machine's own gh, which can answer after a test's wait on a busy runner, or ask GitHub where it is logged in.
// A test hub gives its doctor stand-ins; one that doesn't fails at once, rather than now and then.
import { afterAll, mock } from "bun:test";
import * as sqlite from "bun:sqlite";
import * as doctor from "../src/hub/doctor/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBoxDir } from "../src/node/sandbox/remote/bootstrap.ts";

const runCmd = doctor.runCmd;
mock.module("../src/hub/doctor/index.ts", () => ({
  ...doctor,
  runCmd: async (cmd: string, args: string[]) => {
    if (cmd === "gh") throw new Error("a test started the real gh: give this hub's doctor stand-ins");
    return runCmd(cmd, args);
  },
}));

// Every database a test opens starts without fsync (a hub's own connection sets its WAL's NORMAL after, and the
// helpers' noSync turns that off too). A migration run on a plain connection fsyncs each of its ~180 transactions'
// journals: in an agent's VM, whose $TMPDIR is the machine's disk shared in, that took 2.5-3 s a hub and waited on
// every other VM's writes, against 0.3 s without (test/vault_team_migration.test.ts: 8.8 s, then 2.4 s). Nothing a
// test checks reads durability.
class NoSync extends sqlite.Database {
  constructor(...args: ConstructorParameters<typeof sqlite.Database>) {
    super(...args);
    this.run("PRAGMA synchronous = OFF");
  }
}
mock.module("bun:sqlite", () => ({ ...sqlite, Database: NoSync, default: NoSync }));

// Each test file's own $TMPDIR, removed when the file ends: what its tests and the processes they start make there
// (homes a test never removed, a hub's vault key beside its home) goes with it, and two runs on one machine never
// share a path. It is made under the run's $TMPDIR, kept in FLEETD_TEST_TMPDIR for the next file in this process.
const outer = (process.env.FLEETD_TEST_TMPDIR ??= process.env.TMPDIR ?? tmpdir());
const scratch = mkdtempSync(join(outer, "t-"));
process.env.TMPDIR = scratch;
// A stand-in box (test/sandbox/stand_ins.ts) runs here, and a box keeps its sessions' bundles in BOX_DIR: one /tmp
// path for every test run on the machine, where one run's box sealing cleared another's bundle mid-clone.
setBoxDir(join(scratch, "box"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
