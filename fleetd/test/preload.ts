// Run before every test file (bunfig.toml). A hub's doctor runs `gh auth status` through its default command runner:
// this machine's own gh, which can answer after a test's wait on a busy runner, or ask GitHub where it is logged in.
// A test hub gives its doctor stand-ins; one that doesn't fails at once, rather than now and then.
import { mock } from "bun:test";
import * as doctor from "../src/hub/doctor/index.ts";

const runCmd = doctor.runCmd;
mock.module("../src/hub/doctor/index.ts", () => ({
  ...doctor,
  runCmd: async (cmd: string, args: string[]) => {
    if (cmd === "gh") throw new Error("a test started the real gh: give this hub's doctor stand-ins");
    return runCmd(cmd, args);
  },
}));
