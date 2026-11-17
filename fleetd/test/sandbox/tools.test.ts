// The node's own VM files (sandbox/host/tools.ts), fetched from a local stand-in for GitHub's releases: checked by
// pinned sha256 or the release's SHA256SUMS, unpacked from zstd, kept by version, fetched once at a time, and fetched
// again when a pin changes. Nothing here downloads the real files.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureTools, FetchFailed, findTools, type Pin, PINS, readState } from "../../src/sandbox/host/tools.ts";
import { tempHome } from "../helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const ROOT = new TextEncoder().encode("an ext4 image, or near enough ".repeat(4096));

/** A release server: `files` by name, how often each was asked for, and a switch to break it. */
function release(files: Record<string, Uint8Array | string>) {
  const asked: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.split("/").at(-1) ?? "";
      asked.push(name);
      const body = files[name];
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: (name: string) => `http://127.0.0.1:${server.port}/dl/${name}`, asked, files };
}

function setUp(version = "vm-aaaa") {
  const home = tempHome();
  cleanups.push(home.done);
  const zst = Bun.zstdCompressSync(ROOT);
  const rel = release({
    "cloud-hypervisor-static": "#!/bin/sh\necho ch\n",
    "virtiofsd-x86_64": "#!/bin/sh\necho virtiofsd\n",
    "root-x86_64.ext4.zst": zst,
    SHA256SUMS: `${sha("#!/bin/sh\necho virtiofsd\n")}  virtiofsd-x86_64\n${sha(zst)}  root-x86_64.ext4.zst\n`,
  });
  const pins = (v: string): Pin[] => [
    { name: "cloud-hypervisor", version: "v1", url: rel.url("cloud-hypervisor-static"), file: "cloud-hypervisor", sha256: sha("#!/bin/sh\necho ch\n"), exec: true },
    { name: "ch-remote", version: "v1", url: rel.url("cloud-hypervisor-static"), file: "ch-remote", sha256: sha("#!/bin/sh\necho ch\n"), exec: true },
    { name: "kernel", version: "k1", url: rel.url("cloud-hypervisor-static"), file: "vmlinux", sha256: sha("#!/bin/sh\necho ch\n") },
    { name: "virtiofsd", version: v, url: rel.url("virtiofsd-x86_64"), file: "virtiofsd", exec: true },
    { name: "passt", version: v, url: rel.url("virtiofsd-x86_64"), file: "passt", exec: true },
    { name: "root", version: v, url: rel.url("root-x86_64.ext4.zst"), file: "root.ext4", zstd: true },
  ];
  const fetchOpts = (v = version) => ({ dir: join(home.dir, "vm"), pins: pins(v), sumsUrl: rel.url("SHA256SUMS"), platform: "linux", arch: "x64" });
  return { home, rel, fetchOpts };
}

test("every file comes down once, checked, unpacked and runnable, and the next ask fetches nothing", async () => {
  const { rel, fetchOpts } = setUp();
  expect(findTools(fetchOpts())).toBeUndefined();
  const tools = await ensureTools(fetchOpts());
  expect(tools.root).toBe(join(fetchOpts().dir, "root", "vm-aaaa", "root.ext4"));
  expect(readFileSync(tools.root)).toEqual(Buffer.from(ROOT));
  expect(statSync(tools.cloudHypervisor).mode & 0o111).not.toBe(0);
  expect(statSync(tools.root).mode & 0o111).toBe(0);
  expect(readFileSync(tools.virtiofsd, "utf8")).toContain("virtiofsd");
  expect(findTools(fetchOpts())).toEqual(tools);
  const asked = rel.asked.length;
  expect(await ensureTools(fetchOpts())).toEqual(tools);
  expect(rel.asked.length).toBe(asked);
  expect(readState(fetchOpts().dir)).toBeUndefined();
});

test("callers that come while a fetch is under way wait for that one", async () => {
  const { rel, fetchOpts } = setUp();
  const [a, b] = await Promise.all([ensureTools(fetchOpts()), ensureTools(fetchOpts())]);
  expect(a).toEqual(b);
  expect(rel.asked.filter((n) => n === "root-x86_64.ext4.zst")).toHaveLength(1);
});

test("a download that doesn't match its checksum is refused, leaves nothing, and is remembered for the check", async () => {
  const { rel, fetchOpts } = setUp();
  rel.files["root-x86_64.ext4.zst"] = Bun.zstdCompressSync(new TextEncoder().encode("tampered"));
  const err = await ensureTools(fetchOpts()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(FetchFailed);
  expect((err as Error).message).toBe("the download of root vm-aaaa didn't match its pinned checksum");
  expect(existsSync(join(fetchOpts().dir, "root", "vm-aaaa", "root.ext4"))).toBe(false);
  expect(readdirSync(join(fetchOpts().dir, "root", "vm-aaaa"))).toEqual([]);
  expect(readState(fetchOpts().dir)?.failed).toBe("the download of root vm-aaaa didn't match its pinned checksum");
  // The files checked before it stay, so the next try fetches only what's left.
  expect(existsSync(join(fetchOpts().dir, "cloud-hypervisor", "v1", "cloud-hypervisor"))).toBe(true);
});

test("a release that isn't published yet says so", async () => {
  const { rel, fetchOpts } = setUp();
  delete rel.files.SHA256SUMS;
  const err = (await ensureTools(fetchOpts()).catch((e: unknown) => e)) as Error;
  expect(err).toBeInstanceOf(FetchFailed);
  expect(err.message).toMatch(/^fleetd's VM files for this build \(release vm-[0-9a-f]{12}\) aren't published yet$/u);
});

test("a changed pin fetches that file again and the version it replaces goes; a fetch that works clears the failure", async () => {
  const { rel, fetchOpts } = setUp();
  await ensureTools(fetchOpts());
  rel.asked.length = 0;
  const next = await ensureTools(fetchOpts("vm-bbbb"));
  expect(next.root).toContain("/vm-bbbb/");
  expect(readdirSync(join(fetchOpts().dir, "root"))).toEqual(["vm-bbbb"]);
  expect(rel.asked.sort()).toEqual(["SHA256SUMS", "root-x86_64.ext4.zst", "virtiofsd-x86_64", "virtiofsd-x86_64"]);
  expect(existsSync(join(fetchOpts().dir, "cloud-hypervisor", "v1", "cloud-hypervisor"))).toBe(true);
});

test("off x86_64 Linux nothing is fetched", async () => {
  const { rel, fetchOpts } = setUp();
  const err = (await ensureTools({ ...fetchOpts(), platform: "darwin", arch: "arm64" }).catch((e: unknown) => e)) as Error;
  expect(err.message).toBe("VMs run on x86_64 Linux only, not darwin/arm64");
  expect(rel.asked).toEqual([]);
});

test("the real pins: Cloud Hypervisor's files by sha256, fleetd's own from the recipe's release", () => {
  for (const pin of PINS) {
    if (["cloud-hypervisor", "ch-remote", "kernel"].includes(pin.name)) expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/u);
    else {
      expect(pin.sha256).toBeUndefined();
      expect(pin.url).toMatch(/^https:\/\/github\.com\/unlaboredlabs\/fleetd\/releases\/download\/vm-[0-9a-f]{12}\//u);
    }
  }
  expect(PINS.map((p) => p.name).sort()).toEqual(["ch-remote", "cloud-hypervisor", "kernel", "passt", "root", "virtiofsd"]);
});
