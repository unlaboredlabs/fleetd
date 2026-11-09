// `fleetd init --join <hub> --code <code> --no-service`, the line `fleetd pair --worker` prints, run by the compiled
// binary against a hub on a scratch home: the checklist's join and worker steps, and the node enrolled. Its claude and
// git lines are this machine's own. With --no-service nothing goes to systemd or launchd; `machine add --local` copies
// the binary into its own scratch home.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet } from "./golden.ts";

let bunBin = "";
const fleets: Fleet[] = [];
beforeAll(async () => {
  bunBin = join(process.env.TMPDIR ?? "/tmp", `fleetd-init-join-${process.pid}`, "fleetd");
  const built = Bun.spawnSync(
    ["bun", "build", "--compile", "--minify", "--root", ".", "src/main.ts", "src/hub/store/read-worker.ts", "--outfile", bunBin],
    { cwd: join(import.meta.dir, "../.."), stdout: "ignore", stderr: "pipe" },
  );
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
});
afterAll(async () => {
  for (const f of fleets) await f.stop();
});

async function join_() {
  const fleet = new Fleet("init-join");
  fleets.push(fleet);
  await fleet.startHub();
  const minted = await fleet.run(["pair", "--worker", "builder-1"]);
  const code = /fle_[a-z2-7]{52}/.exec(minted.stdout)![0];
  // The worker is another fleetd home on this machine; its hub is the one above.
  const worker = new Fleet("init-join-worker");
  fleets.push(worker);
  const proc = Bun.spawn([bunBin, "init", "--join", fleet.hubUrl, "--code", code, "--machine-id", "builder-1", "--no-service"], {
    cwd: worker.cwd,
    env: { ...worker.env(), PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const node = JSON.parse(readFileSync(join(worker.home, "node", "node.json"), "utf8"));
  const shown = worker.normalize({ code: exit, stdout, stderr: stderr.replaceAll(fleet.hubUrl, "HUBURL") });
  return { shown, node };
}

test("a worker joins with the code", async () => {
  const joined = await join_();
  expect(joined.node.enrolled).toBe(true);
  expect(joined.node.machineId).toBe("builder-1");
  expect(joined.shown.stderr).toContain("\nJoin a hub  1/2\n\nWorker  2/2\n–  builder-1 enrolled; its node isn't started (--no-service)\n");
  expect(joined.shown.stderr).toContain("start builder-1's node: $HOME/bin/fleetd node run --home $HOME/node");
}, 60_000);
