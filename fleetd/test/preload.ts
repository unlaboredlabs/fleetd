// Run before every test file (bunfig.toml). A hub's doctor runs `gh auth status` through its default command runner:
// this machine's own gh, which can answer after a test's wait on a busy runner, or ask GitHub where it is logged in.
// A test hub gives its doctor stand-ins; one that doesn't fails at once, rather than now and then.
import { afterAll, beforeAll, mock } from "bun:test";
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

// A stand-in box (test/sandbox/stand_ins.ts) runs here, and a box keeps its sessions' bundles in BOX_DIR: one /tmp
// path for every test run on the machine, where one run's box sealing cleared another's bundle mid-clone. Each test
// process takes its own.
let boxDir: string | undefined;
beforeAll(() => {
  boxDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fleetd-box-"));
  setBoxDir(boxDir);
});
afterAll(() => {
  if (boxDir) rmSync(boxDir, { recursive: true, force: true });
});
