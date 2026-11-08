// `fleetd init --join <hub> --code <code> --no-service`, the line `fleetd pair --worker` prints, run by the Bun binary
// and the Rust one against a Rust hub each, on scratch homes: the same checklist, and the node enrolled. With
// --no-service nothing goes to systemd or launchd; `machine add --local` copies each binary into its own scratch home.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet, RUST } from "./golden.ts";

let bunBin = "";
const fleets: Fleet[] = [];
beforeAll(async () => {
  if (!RUST) return;
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

async function joinWith(which: "rust" | "bun") {
  const fleet = new Fleet(`init-join-${which}`);
  fleets.push(fleet);
  await fleet.startRustHub();
  const minted = await fleet.run("rust", ["pair", "--worker", "builder-1"]);
  const code = /fle_[a-z2-7]{52}/.exec(minted.stdout)![0];
  // The worker is another fleetd home on this machine; its hub is the one above.
  const worker = new Fleet(`init-join-${which}-worker`);
  fleets.push(worker);
  const bin = which === "rust" ? RUST! : bunBin;
  const proc = Bun.spawn([bin, "init", "--join", fleet.hubUrl, "--code", code, "--machine-id", "builder-1", "--no-service"], {
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

test.skipIf(!RUST)("a worker joins with the code, as the Rust binary joins", async () => {
  const rust = await joinWith("rust");
  const bun = await joinWith("bun");
  expect(bun.node.enrolled).toBe(true);
  expect(bun.node.machineId).toBe("builder-1");
  expect(bun.shown).toEqual(rust.shown);
}, 60_000);
