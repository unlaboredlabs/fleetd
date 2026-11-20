// What local VMs left on a machine updated past their removal (src/node/place/left_vm.ts): a box's record ends with its
// transcript back here, a process its marker names under this node's hosts is ended (another fleet's stays), and the
// sweep clears the VMs' files but the hosted boxes' images.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxFile, destroyBox, reapLeaked, sweepVm } from "../../src/node/place/left_vm.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-left-vm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a box's record ends: its transcript comes back here where the box's is newer, and the record goes", async () => {
  const dir = join(root, "hosts", "s1");
  mkdirSync(dir, { recursive: true });
  const here = join(root, "claude", "projects", "w", "s1.jsonl");
  const box = join(root, "vm", "homes", "s1", ".claude", "projects", "w", "s1.jsonl");
  mkdirSync(join(box, ".."), { recursive: true });
  mkdirSync(join(here, ".."), { recursive: true });
  writeFileSync(here, "old\n");
  writeFileSync(box, "old\nnewer turn\n");
  utimesSync(here, new Date(1_000_000), new Date(1_000_000));
  // A leader long gone (a pid no process has at that start): nothing to kill, the transcript still comes back.
  writeFileSync(boxFile(dir), JSON.stringify({ kind: "microvm", leader: { pid: 2 ** 22 - 1, start: 1 }, helpers: [], transcript: { here, box } }));
  expect(await destroyBox(dir)).toBe(0);
  expect(readFileSync(here, "utf8")).toBe("old\nnewer turn\n");
  expect(existsSync(boxFile(dir))).toBe(false);
  // Nothing recorded: nothing to do.
  expect(await destroyBox(dir)).toBe(0);
});

test.skipIf(process.platform !== "linux")("a process a box left under this node's hosts is ended by its marker; another fleet's stays", async () => {
  const hosts = join(root, "node", "hosts");
  const other = join(root, "other", "hosts");
  const spawn = (marker: string) => Bun.spawn(["sleep", "60"], { env: { ...process.env, FLEETD_BOX: marker }, stdio: ["ignore", "ignore", "ignore"] });
  const ours = spawn(join(hosts, "s2"));
  const theirs = spawn(join(other, "s2"));
  try {
    expect(await reapLeaked(hosts)).toBeGreaterThanOrEqual(1);
    expect(await ours.exited).not.toBe(0);
    expect(theirs.exitCode).toBeNull();
  } finally {
    ours.kill("SIGKILL");
    theirs.kill("SIGKILL");
  }
});

test("the sweep clears the VMs' files and keeps the hosted boxes' images", () => {
  const home = join(root, "sweep");
  const vm = join(home, "vm");
  for (const d of ["cloud-hypervisor/48.0", "homes/s1/.claude", "env/s1", "cache/bun", "claude", "images/build/shop", "disks"]) mkdirSync(join(vm, d), { recursive: true });
  writeFileSync(join(vm, "images", "shop.json"), JSON.stringify({ ready: { where: "vm", ref: "/x", key: "k" } }));
  writeFileSync(join(vm, "images", "shop-k.img"), "disk");
  writeFileSync(join(vm, "images", "api.json"), JSON.stringify({ ready: { where: "boat", ref: "snap-1", key: "k" } }));
  writeFileSync(join(vm, "images", "web.json"), JSON.stringify({ failed: { key: "k", at: "t", log: "" } }));
  writeFileSync(join(vm, "disks", "s1.img"), "");
  writeFileSync(join(vm, "disks", "s1.layer.img"), "");
  writeFileSync(join(vm, "disks", "s1.image.json"), JSON.stringify({ where: "vm", ref: "/x" }));
  writeFileSync(join(vm, "disks", "s2.image.json"), JSON.stringify({ where: "boat", ref: "snap-1" }));
  expect(sweepVm(home)).toBeGreaterThan(0);
  expect(readdirSync(vm).sort()).toEqual(["disks", "images"]);
  expect(readdirSync(join(vm, "images")).sort()).toEqual(["api.json", "web.json"]);
  expect(readdirSync(join(vm, "disks"))).toEqual(["s2.image.json"]);
  // Again: nothing left to take; and a node with no vm folder at all.
  expect(sweepVm(home)).toBe(0);
  expect(sweepVm(join(root, "none"))).toBe(0);
});
