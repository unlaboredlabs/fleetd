// `fleetd init --join <hub> --code <code> --no-service`, the line `fleetd pair --worker` prints, run by the compiled
// binary against a hub on a scratch home: the checklist's join and worker steps, and the node enrolled. Its claude is a
// stand-in on PATH (CI's runner has none, and a join refuses a machine without one); its git line is this machine's
// own. With --no-service nothing goes to systemd or launchd; `machine add --local` copies the binary into its own
// scratch home.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localHostName, machineIdFromHost } from "../../src/cli/project.ts";
import { createEnrollToken, openHub } from "../../src/cli/store.ts";
import { TESTED } from "../../src/node/runner/claude.ts";
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

/** A code `fleetd pair --worker builder-1` prints. */
async function named(fleet: Fleet): Promise<string> {
  const minted = await fleet.run(["pair", "--worker", "builder-1"]);
  return /fle_[a-z2-7]{52}/.exec(minted.stdout)![0];
}

async function join_(mint: (fleet: Fleet) => Promise<string> = named, args = ["--machine-id", "builder-1"]) {
  const fleet = new Fleet("init-join");
  fleets.push(fleet);
  await fleet.startHub();
  const code = await mint(fleet);
  // The worker is another fleetd home on this machine; its hub is the one above.
  const worker = new Fleet("init-join-worker");
  fleets.push(worker);
  const bin = join(worker.home, "stand-in");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '${TESTED} (Claude Code)'\n`, { mode: 0o755 });
  const proc = Bun.spawn([bunBin, "init", "--join", fleet.hubUrl, "--code", code, ...args, "--no-service"], {
    cwd: worker.cwd,
    env: { ...worker.env(), PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  // A join that wrote no node.json fails with its own words, not ENOENT.
  if (!existsSync(join(worker.home, "node", "node.json"))) throw new Error(`init --join exited ${exit} without node.json\nstdout: ${stdout}\nstderr: ${stderr}`);
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

test("a line minted for no machine joins under this computer's name, made unique when another has it", async () => {
  const own = machineIdFromHost(localHostName());
  const joined = await join_(async (fleet) => {
    const db = openHub(fleet.hubHome);
    try {
      // An open code for another computer of this name takes it.
      createEnrollToken(db, own);
      return createEnrollToken(db, undefined).token;
    } finally {
      db.conn.close();
    }
  }, []);
  const settled = `${own.slice(0, 30).replace(/-+$/, "")}-2`;
  expect(joined.node.enrolled).toBe(true);
  expect(joined.node.machineId).toBe(settled);
  expect(joined.node.name).toBe(settled);
  expect(joined.shown.stderr).toContain(`–  ${settled} enrolled; its node isn't started (--no-service)\n`);
}, 60_000);
