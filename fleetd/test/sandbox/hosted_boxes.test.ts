// A hosted box's whole life against each provider's stand-in server (stand_ins.ts with a Runner): the node's Boxes
// (src/node/sandbox/remote/boxes.ts) builds the template, creates the box with labels and no secret, starts the
// bootstrap with the box's own secret, hands it this fleetd, and opens the guest's link through the provider's port;
// then commands, files in and out, and the box's delete, and the reaper of boxes no session holds. The bootstrap and
// the guest run here as the provider would run them in the box.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { boatStandIn, daytonaStandIn, e2bStandIn, KEY, localRunner, type StandIn } from "./stand_ins.ts";
import { provider, type ProviderId } from "../../src/sandbox/providers/index.ts";
import { Boxes, DOWN_MS, hostable, MACHINE_LABEL, SESSION_LABEL } from "../../src/node/sandbox/remote/boxes.ts";
import { BOX_DIR } from "../../src/node/sandbox/remote/bootstrap.ts";
import { type Box } from "../../src/node/sandbox/box.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hosted-"));
const running: StandIn[] = [];
const opened: Box[] = [];
afterEach(() => {
  for (const b of opened.splice(0)) b.close();
  for (const s of running.splice(0)) s.stop();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** "fleetd" as the box gets it: a script that runs this checkout's fleetd under this Bun. */
const FLEETD = new TextEncoder().encode(`#!/bin/sh\nexec ${process.execPath} ${MAIN} "$@"\n`);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

let made = 0;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A stand-in for `id` whose boxes run here, each with a port and a box dir of its own. */
async function world(id: ProviderId) {
  const dir = join(root, `w${++made}`);
  mkdirSync(dir, { recursive: true });
  const local = localRunner(join(dir, "boxes"), BOX_DIR);
  cleanups.push(local.cleanup);
  const s = id === "e2b" ? e2bStandIn(local.runner) : id === "boat" ? boatStandIn(local.runner) : daytonaStandIn(local.runner);
  running.push(s);
  local.track(s);
  const api = id === "boat" ? `${s.url}/api/v1` : s.url;
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const boxes = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  boxes.setKeys({ [id]: Buffer.from(JSON.stringify({ provider: id, key: KEY })).toString("base64") });
  boxes.wire({ lead: { relay: new LeadRelay(), identify: () => ({ kind: "none" }) as never, maskFor: () => new Masker([]) } });
  return { s, boxes, home };
}

for (const id of ["e2b", "boat", "daytona"] as const) {
  describe(id, () => {
    test("a box comes up from the built template with fleetd handed to it, runs commands, takes files and goes", async () => {
      const { s, boxes } = await world(id);
      const record = await boxes.create(id, "sess-1", [], []);
      // Built once, kept for the next box.
      expect(await boxes.template(id)).toBe(await boxes.template(id));
      const b = s.boxes.get(record.boxId);
      const labels = b.labels ?? b.metadata;
      expect(labels).toMatchObject({ [MACHINE_LABEL]: "devbox", [SESSION_LABEL]: "sess-1", fleetd: "1" });
      // The create holds no secret: the box's own secret went only to its start.
      expect(JSON.stringify(b.req)).not.toContain(record.secret);
      const box = await boxes.open(record, "sess-1");
      opened.push(box);
      const ran = await box.run({ argv: ["sh", "-c", "echo hello from $0"], cwd: "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutSec: 20 });
      expect(ran).toMatchObject({ exitCode: 0, timedOut: false });
      expect(ran.outputTail).toContain("hello from sh");
      // A file larger than one control message goes in pieces, both ways.
      const big = new Uint8Array(1_500_000).map((_, i) => i % 251);
      const at = join(root, `file-${id}.bin`);
      await box.write(at, big);
      expect(Buffer.compare(Buffer.from(await box.read(at, 2_000_000)), Buffer.from(big))).toBe(0);
      await expect(box.read(at, 1000)).rejects.toThrow("larger than 1000 bytes");
      await boxes.extend(record);
      await boxes.destroy(record);
      expect(s.boxes.has(record.boxId)).toBe(false);
    }, 60_000);
  });
}

test("a box whose guest doesn't take the secret is never reached; the bootstrap refuses fleetd with a wrong checksum", async () => {
  const { boxes } = await world("e2b");
  const bad = new Boxes(join(root, "bad"), "devbox", { open: (b) => b }, {
    provider: (p, auth) => boxes.client(p),
    source: () => ({ sha256: "0".repeat(64), bytes: async () => FLEETD }),
  });
  bad.setKeys({ e2b: Buffer.from(JSON.stringify({ provider: "e2b", key: KEY })).toString("base64") });
  await expect(bad.create("e2b", "sess-2", [], [])).rejects.toThrow("SHA-256");
}, 60_000);

test("the reaper deletes this machine's boxes no session holds, and no one else's", async () => {
  const { s, boxes } = await world("boat");
  const client = boxes.client("boat");
  await client.create({ template: "t", key: "k-mine", labels: { [MACHINE_LABEL]: "devbox", [SESSION_LABEL]: "gone" }, lifetimeMs: 60_000 });
  const kept = await client.create({ template: "t", key: "k-kept", labels: { [MACHINE_LABEL]: "devbox", [SESSION_LABEL]: "live" }, lifetimeMs: 60_000 });
  const other = await client.create({ template: "t", key: "k-other", labels: { [MACHINE_LABEL]: "laptop", [SESSION_LABEL]: "x" }, lifetimeMs: 60_000 });
  expect(await boxes.reap(() => new Set([kept.id]))).toBe(1);
  expect([...s.boxes.keys()].sort()).toEqual([kept.id, other.id].sort());
});

test("only an x86_64 node makes hosted boxes: an arm64 one says so", () => {
  expect(hostable("x64")).toBe(true);
  expect(hostable("arm64")).toBe(false);
});

test("keys: a provider not sent again is forgotten, on disk too; a key that doesn't open is ignored", async () => {
  const home = join(root, "keys");
  const b = new Boxes(home, "devbox", { open: (x) => (x[0] === 0x7b ? x : null) });
  b.setKeys({ e2b: Buffer.from(JSON.stringify({ provider: "e2b", key: "k1" })).toString("base64"), boat: Buffer.from("junk").toString("base64") });
  expect(b.connected()).toEqual(["e2b"]);
  expect(existsSync(join(home, "sandbox", "keys", "e2b"))).toBe(true);
  // A node that starts again reads them back.
  expect(new Boxes(home, "devbox", { open: (x) => x }).connected()).toEqual(["e2b"]);
  // A provider that failed to make a box is offered no more for a while, then again.
  b.setAside("e2b", "E2B's limit for this team is reached", 1_000);
  expect(b.usable(1_000 + 60_000)).toEqual([]);
  expect(b.usable(1_000 + DOWN_MS)).toEqual(["e2b"]);
  b.setKeys({});
  expect(b.connected()).toEqual([]);
  expect(existsSync(join(home, "sandbox", "keys", "e2b"))).toBe(false);
});
