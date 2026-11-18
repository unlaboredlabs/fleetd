// How long a bot with a heavy setup takes to start in a local VM: from a session's start until its setup is done and its
// box has run a command that needs what setup installed. The same script measures both ways:
//   --mode clean   setup runs in each new box (what main does, and what a session with no image does)
//   --mode image   the bot's computer image is built once (timed apart), and each new box starts from it
// It drives the node's own MicroVm (Cloud Hypervisor, KVM) with a home of its own: no hub, no node service, no Claude,
// nothing of a running fleet. Run it on a Linux machine that runs VMs (not inside one), with fleetd's built binary:
//
//   cd fleetd && bun run compile
//   bun scripts/bench-image-start.ts --fleetd ./dist/fleetd --home /home/<you>/fleetd-sweeps/W705/bench --mode clean --runs 3
//   bun scripts/bench-image-start.ts --fleetd ./dist/fleetd --home /home/<you>/fleetd-sweeps/W705/bench --mode image --runs 3
//
// --setup '<command>' replaces the default (a minimal Rust toolchain through rustup); --check '<command>' what the box
// then runs (default `rustc --version`). One line of JSON a run, then a summary line. `--mode image` needs the image
// support of node/place/image.ts; `--mode clean` runs on a checkout from before it too.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LeadRelay, type LeadSocketHooks } from "../src/node/lead/index.ts";
import { Masker } from "../src/node/mask.ts";
import { MicroVm } from "../src/node/place/microvm.ts";
import * as setup from "../src/node/worktree/setup.ts";
import { ensureTools, vmDir } from "../src/sandbox/host/tools.ts";

const { values: a } = parseArgs({
  options: {
    fleetd: { type: "string" },
    home: { type: "string" },
    mode: { type: "string", default: "clean" },
    runs: { type: "string", default: "3" },
    setup: { type: "string", default: "curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable" },
    check: { type: "string", default: ". \"$HOME/.cargo/env\" && rustc --version" },
  },
});
if (!a.fleetd || !a.home || !["clean", "image"].includes(a.mode!)) {
  console.error("usage: bun scripts/bench-image-start.ts --fleetd <built fleetd> --home <a dir of its own> --mode clean|image [--runs N] [--setup CMD] [--check CMD]");
  process.exit(2);
}
const home = resolve(a.home);
mkdirSync(home, { recursive: true });
const runs = Number(a.runs);

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=bench", "-c", "user.email=bench@localhost", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

// A bot's checkout: a lockfile that is setup's input.
const repo = mkdtempSync(join(home, "repo-"));
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n');
git(repo, "add", ".");
git(repo, "commit", "-qm", "bench");
const plan: setup.Plan = { commands: [a.setup!], inputs: ["rust-toolchain.toml"] };

console.error("fetching the VM files when missing…");
await ensureTools({ dir: vmDir(home) });
const relay = new LeadRelay();
relay.attach(() => {}, []);
const hooks: LeadSocketHooks = { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() };
const vm = new MicroVm({ home, fleetd: [resolve(a.fleetd)], lead: () => hooks });
const status = vm.status();
if (status.kind !== "microvm") throw new Error(`this machine runs no VMs: ${JSON.stringify(status)}`);

type Images = import("../src/node/place/image.ts").Images;
let images: Images | undefined;
if (a.mode === "image") {
  const { Images } = await import("../src/node/place/image.ts");
  images = new Images({ home, backend: () => vm.backend(), root: () => repo, vars: () => ({ env: {}, secrets: [] }) });
  const t0 = performance.now();
  images.status("bench", plan);
  await images.idle();
  const st = images.status("bench", plan);
  if (st.state !== "ready") throw new Error(`the image didn't build: ${st.log ?? st.state}`);
  console.log(JSON.stringify({ build: true, ms: Math.round(performance.now() - t0), bytes: st.bytes }));
}

const took: number[] = [];
for (let i = 0; i < runs; i++) {
  const session = `bench-${a.mode}-${Date.now()}-${i}`;
  const wt = join(home, "worktrees", session);
  mkdirSync(join(home, "worktrees"), { recursive: true });
  git(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
  const dir = join(home, "hosts", session);
  const place = vm.bound({ sessionId: session, dir, role: "worker" });
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin" };
  const t0 = performance.now();
  const image = images?.use("bench", plan, wt, session, "vm");
  const outcome = await setup.run(place, plan, wt, env, [], () => {}, () => {}, undefined, image);
  const ran = await place.run({ cwd: wt, argv: ["sh", "-c", a.check!], timeoutSec: 600, env });
  const ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ mode: a.mode, run: i + 1, ms, setup: outcome.kind, check: ran.exitCode, out: ran.outputTail.trim().split("\n").at(-1) }));
  if (ran.exitCode !== 0) throw new Error(`the check failed in the box: ${ran.notRun ?? ran.outputTail}`);
  took.push(ms);
  await place.end(dir);
  git(repo, "worktree", "remove", "--force", wt);
}
const sorted = [...took].sort((x, y) => x - y);
console.log(JSON.stringify({ mode: a.mode, runs, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) }));
vm.close();
rmSync(repo, { recursive: true, force: true });
