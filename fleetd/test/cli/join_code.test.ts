// A join's one-time code stays out of every command's arguments, which any user on the machine can list (ps): the
// lines put it in FLEETD_JOIN_CODE, which `fleetd init --join` reads and takes out of its environment.
import { expect, test } from "bun:test";
import { joinLine } from "../../src/cli/pair.ts";
import { initOptions } from "../../src/cli/setup/index.ts";
import { pastedJoin } from "../../src/cli/setup/wizard.ts";

test("the join line carries its code in the installer's environment, never in its arguments", () => {
  const line = joinLine("http://devbox.example:4790", "fle_abc", "laptop");
  expect(line).toBe("curl -fsSL https://fleetd.sh | FLEETD_JOIN_CODE=fle_abc sh -s -- --join http://devbox.example:4790 --machine-id laptop");
  expect(line.slice(line.indexOf("sh -s --"))).not.toContain("fle_abc");
  // Pasted into the wizard, it reads as before; an older line's --code too.
  expect(pastedJoin(line)).toEqual({ hub: "http://devbox.example:4790", code: "fle_abc", machineId: "laptop" });
  expect(pastedJoin("curl -fsSL https://fleetd.sh | FLEETD_JOIN_CODE='a b' sh -s -- --join http://h:1")).toMatchObject({ code: "a b" });
  expect(pastedJoin("curl -fsSL https://fleetd.sh | sh -s -- --join http://h:1 --code old")).toMatchObject({ code: "old" });
});

test("init --join takes its code from FLEETD_JOIN_CODE, and nothing it starts inherits it", () => {
  const env: Record<string, string | undefined> = { FLEETD_JOIN_CODE: "fle_abc" };
  const opts = initOptions(["--join", "http://h:1", "--no-service"], env);
  expect(typeof opts === "object" && opts.join).toEqual(["http://h:1", "fle_abc"]);
  expect("FLEETD_JOIN_CODE" in env).toBe(false);
  // --code still works, and wins.
  const both = initOptions(["--join", "http://h:1", "--code", "given"], { FLEETD_JOIN_CODE: "env" });
  expect(typeof both === "object" && both.join).toEqual(["http://h:1", "given"]);
});
