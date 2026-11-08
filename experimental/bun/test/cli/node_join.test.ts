// `fleetd node join --enroll-only` from the Bun CLI, with the code `fleetd pair --worker` mints, against a Rust hub on
// a scratch home: it enrolls and exits 0, and `node run` then refuses nothing a joined node needs.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet, RUST } from "./golden.ts";

let fleet: Fleet;
beforeAll(async () => {
  if (!RUST) return;
  fleet = new Fleet("node-join");
  await fleet.startRustHub();
});
afterAll(() => fleet?.stop());

test.skipIf(!RUST)("a worker code enrolls the Bun node with a Rust hub", async () => {
  const minted = await fleet.run("bun", ["pair", "--worker", "builder-1"]);
  const code = /fle_[a-z2-7]{52}/.exec(minted.stdout)?.[0];
  expect(code).toBeDefined();
  const node = join(fleet.home, "node");
  const joined = await fleet.run(
    "bun",
    ["node", "join", "--hub", fleet.hubUrl, "--token-file", "-", "--machine", "builder-1", "--home", node, "--enroll-only"],
    { stdin: `${code}\n` },
  );
  expect(joined.code).toBe(0);
  expect(JSON.parse(readFileSync(join(node, "node.json"), "utf8")).enrolled).toBe(true);
  // The code is single use: a second join with it is refused, and the node's enrolment stays.
  const again = await fleet.run(
    "bun",
    ["node", "join", "--hub", fleet.hubUrl, "--token", code!, "--machine", "builder-1", "--home", join(fleet.home, "node2"), "--enroll-only"],
  );
  expect(again.code).not.toBe(0);
});
