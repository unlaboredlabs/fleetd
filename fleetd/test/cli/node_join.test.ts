// `fleetd node join --enroll-only` with the code `fleetd pair --worker` mints, against a hub on
// a scratch home: it enrolls and exits 0, and `node run` then refuses nothing a joined node needs.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet } from "./golden.ts";

let fleet: Fleet;
beforeAll(async () => {
  fleet = new Fleet("node-join", { tools: true });
  await fleet.startHub();
});
afterAll(() => fleet?.stop());

test("a worker code enrolls the node with the hub", async () => {
  const minted = await fleet.run(["pair", "--worker", "builder-1"]);
  const code = /fle_[a-z2-7]{52}/.exec(minted.stdout)?.[0];
  expect(code).toBeDefined();
  const node = join(fleet.home, "node");
  const joined = await fleet.run(["node", "join", "--hub", fleet.hubUrl, "--token-file", "-", "--machine", "builder-1", "--home", node, "--enroll-only"],
    { stdin: `${code}\n` },
  );
  expect(joined.code).toBe(0);
  expect(JSON.parse(readFileSync(join(node, "node.json"), "utf8")).enrolled).toBe(true);
  // The code is single use: a second join with it is refused, and the node's enrolment stays.
  const again = await fleet.run(["node", "join", "--hub", fleet.hubUrl, "--token", code!, "--machine", "builder-1", "--home", join(fleet.home, "node2"), "--enroll-only"],
  );
  expect(again.code).not.toBe(0);
});

// Run again from the shell's history with its spent code, a join wrote enrolled: false before the workspace refused it,
// and left a working machine un-enrolled: `node run` then said it had never joined.
test("a join run again with a spent code keeps the machine joined", async () => {
  const minted = await fleet.run(["pair", "--worker", "builder-2"]);
  const code = /fle_[a-z2-7]{52}/.exec(minted.stdout)![0];
  const node = join(fleet.home, "node-twice");
  const argv = ["node", "join", "--workspace", fleet.hubUrl, "--token", code, "--machine", "builder-2", "--home", node, "--enroll-only"];
  expect((await fleet.run(argv)).code).toBe(0);
  const before = readFileSync(join(node, "node.json"), "utf8");
  const again = await fleet.run(argv);
  expect(again.code).not.toBe(0);
  expect(again.stderr).toContain("already used");
  expect(again.stderr).toContain(`nothing changed here: builder-2 is still joined to ${fleet.hubUrl}`);
  expect(readFileSync(join(node, "node.json"), "utf8")).toBe(before);
  expect(JSON.parse(before).enrolled).toBe(true);
});

// `--mac` reaches the join (it was once dropped, so the agents' Mac joined as a plain runner): off a Mac it refuses
// before writing anything, with may_join's words. On the Mac it writes `agentsMac` and `mac.enabled`.
test.skipIf(process.platform === "darwin")("node join --mac off a Mac refuses and writes no config", async () => {
  const fleet = new Fleet("node-join-mac", { tools: true });
  try {
    const node = join(fleet.home, "node");
    const joined = await fleet.run(["node", "join", "--hub", "http://127.0.0.1:9", "--token", "fle_x", "--machine", "mac-1", "--mac", "--home", node]);
    expect(joined.code).toBe(1);
    expect(joined.stderr).toContain("--mac is for the agents' Mac");
    expect(existsSync(join(node, "node.json"))).toBe(false);
  } finally {
    await fleet.stop();
  }
});
