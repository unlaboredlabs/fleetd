import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallOutcome } from "../shared/hub";
import type { JoinHere } from "../shared/joinHere";
import { assetFor, expectedSum, fingerprintOf, fleetdDir, joinHere, machineFingerprint, platformUuid, thisComputer, type JoinPorts } from "./joinHere";

const BUILD = new TextEncoder().encode("#!/bin/sh\necho fleetd\n");
const SUM = createHash("sha256").update(BUILD).digest("hex");
const CODE = "fle_onetimecode";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** A temp fleetd dir, a hub that answers machine_join, release files and a CLI that does what `exit` says. */
function ports(over: { sums?: string; exit?: number; join?: CallOutcome; version?: string; nightlyIs?: string; info?: CallOutcome; hubFingerprint?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-join-"));
  homes.push(dir);
  const ran: Array<{ file: string; args: ReadonlyArray<string> }> = [];
  const fetched: string[] = [];
  const p: JoinPorts = {
    call: (tool) =>
      Promise.resolve(
        tool === "machine_join"
          ? (over.join ?? {
              ok: true,
              output: { machineId: "laptop", hubUrl: "http://devbox.example.ts.net:4790", code: CODE, expiresAt: "x", gitIdentity: "ada <1+ada@users.noreply.github.com>", line: "" },
            })
          : (over.info ?? { ok: true, output: { version: over.version ?? "0.9.0-nightly.20261020", machineFingerprint: over.hubFingerprint ?? "e".repeat(64) } }),
      ),
    download: (url) => {
      fetched.push(url);
      if (url.endsWith("/release.json")) return Promise.resolve(new TextEncoder().encode(JSON.stringify({ cliVersion: over.nightlyIs ?? "0.9.0-nightly.20261020" })));
      return Promise.resolve(url.endsWith("/SHA256SUMS") ? new TextEncoder().encode(over.sums ?? `${SUM}  fleetd-linux-x64\n${"0".repeat(64)}  fleetd-darwin-arm64\n`) : BUILD);
    },
    run: (file, args) => {
      ran.push({ file, args });
      return Promise.resolve({ code: over.exit ?? 0, output: over.exit ? "joining http://devbox.example.ts.net:4790\nerror: claude is not installed\n" : "joined\n" });
    },
    fleetdDir: dir,
    fingerprint: () => Promise.resolve("f".repeat(64)),
    baseOverride: undefined,
    platform: "linux",
    arch: "x64",
  };
  return { p, dir, ran, fetched };
}

describe("joining this computer", () => {
  it("downloads the hub's own nightly build, checks it, installs it and runs fleetd init --join", async () => {
    const { p, dir, ran, fetched } = ports();
    const seen: JoinHere[] = [];
    const end = await joinHere(p, "laptop", (s) => seen.push(s));
    expect(end.state).toBe("done");
    expect(end.steps.every((s) => s.state === "done")).toBe(true);
    expect(fetched).toEqual([
      "https://github.com/unlaboredlabs/fleetd/releases/download/nightly/release.json",
      "https://github.com/unlaboredlabs/fleetd/releases/download/nightly/SHA256SUMS",
      "https://github.com/unlaboredlabs/fleetd/releases/download/nightly/fleetd-linux-x64",
    ]);
    const bin = path.join(dir, "bin", "fleetd");
    expect(fs.readFileSync(bin)).toEqual(Buffer.from(BUILD));
    expect(fs.statSync(bin).mode & 0o777).toBe(0o755);
    expect(ran).toEqual([
      {
        file: bin,
        args: ["init", "--join", "http://devbox.example.ts.net:4790", "--code", CODE, "--machine-id", "laptop", "--git-identity", "ada <1+ada@users.noreply.github.com>"],
      },
    ]);
    // Each step went running before it was done, and the code never went to the page.
    expect(seen.map((s) => s.steps.findIndex((x) => x.state === "running"))).toEqual([0, 1, 2, 3, 4, 5, -1]);
    expect(JSON.stringify(seen)).not.toContain(CODE);
  });

  it("installs nothing when the build doesn't match SHA256SUMS", async () => {
    const { p, dir, ran } = ports({ sums: `${"a".repeat(64)}  fleetd-linux-x64\n` });
    const end = await joinHere(p, "laptop", () => undefined);
    expect(end.state).toBe("failed");
    expect(end.steps.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "planned", "planned"]);
    expect(end.message).toContain("doesn't match SHA256SUMS");
    expect(fs.existsSync(path.join(dir, "bin", "fleetd"))).toBe(false);
    expect(ran).toEqual([]);
  });

  it("downloads a stable hub's own release, never the latest", async () => {
    const { p, fetched } = ports({ version: "0.9.2" });
    expect((await joinHere(p, "laptop", () => undefined)).state).toBe("done");
    expect(fetched).toEqual([
      "https://github.com/unlaboredlabs/fleetd/releases/download/v0.9.2/SHA256SUMS",
      "https://github.com/unlaboredlabs/fleetd/releases/download/v0.9.2/fleetd-linux-x64",
    ]);
  });

  it("asks to update a nightly hub the nightly release has moved past, and installs nothing", async () => {
    const { p, dir, fetched, ran } = ports({ nightlyIs: "0.9.0-nightly.20261027" });
    const end = await joinHere(p, "laptop", () => undefined);
    expect(end.state).toBe("failed");
    expect(end.message).toContain("The hub runs 0.9.0-nightly.20261020, and the nightly release is now 0.9.0-nightly.20261027. Update the hub first");
    expect(fetched).toEqual(["https://github.com/unlaboredlabs/fleetd/releases/download/nightly/release.json"]);
    expect(fs.existsSync(path.join(dir, "bin", "fleetd"))).toBe(false);
    expect(ran).toEqual([]);
  });

  /** A fleetd dir with a hub or a node in it, and its bin/fleetd: none of it may change. */
  const occupied = (dir: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries({ ...files, "bin/fleetd": "the hub's own build" })) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
  };

  for (const [what, files, says] of [
    ["the hub's database", { "hub/hub.sqlite": "" }, "This computer runs the hub"],
    ["the hub's setup", { "hub/setup.json": "{}" }, "This computer runs the hub"],
    [
      "a node enrolled under another id",
      { "node/node.json": JSON.stringify({ hub: "http://devbox.example.ts.net:4790", machineId: "studio", enrolled: true }) },
      "This computer is already part of the hub at http://devbox.example.ts.net:4790 as studio",
    ],
  ] as const) {
    it(`never replaces the fleetd or enrolls again where the fleetd dir holds ${what}`, async () => {
      const { p, dir, fetched, ran } = ports();
      occupied(dir, files);
      const calls: string[] = [];
      const call = p.call.bind(p);
      const end = await joinHere({ ...p, call: (tool, input) => (calls.push(tool), call(tool, input)) }, "laptop", () => undefined);
      expect(end.state).toBe("failed");
      expect(end.message).toContain(says);
      expect(end.steps.map((s) => s.state)).toEqual(["failed", "planned", "planned", "planned", "planned", "planned"]);
      expect(calls).toEqual(["hub_info"]);
      expect(fetched).toEqual([]);
      expect(ran).toEqual([]);
      expect(fs.readFileSync(path.join(dir, "bin", "fleetd"), "utf8")).toBe("the hub's own build");
    });
  }

  it("never joins the hub's own computer, whatever its fleetd dir holds", async () => {
    // The hub keeps its data in a folder of its own (FLEETD_HOME, --home): this computer's fleetd dir looks empty.
    const { p, dir, fetched, ran } = ports({ hubFingerprint: "f".repeat(64) });
    const calls: string[] = [];
    const call = p.call.bind(p);
    const end = await joinHere({ ...p, call: (tool, input) => (calls.push(tool), call(tool, input)) }, "laptop", () => undefined);
    expect(end.state).toBe("failed");
    expect(end.message).toContain("This computer runs the hub");
    expect(calls).toEqual(["hub_info"]);
    expect(fetched).toEqual([]);
    expect(ran).toEqual([]);
    expect(fs.existsSync(path.join(dir, "bin", "fleetd"))).toBe(false);
  });

  it("joins nothing while the hub can't say which computer it runs on", async () => {
    const { p, fetched, ran } = ports({ info: { ok: false, error: { code: "timeout", message: "The hub didn't answer." } } });
    const end = await joinHere(p, "laptop", () => undefined);
    expect(end.state).toBe("failed");
    expect(end.message).toContain("Couldn't ask the hub which computer it runs on");
    expect(fetched).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("reads what this computer's fleetd dir holds", async () => {
    const { dir } = ports();
    expect(await thisComputer(dir)).toEqual({ kind: "none" });
    occupied(dir, { "node/node.json": JSON.stringify({ hub: "http://devbox:4790", machineId: "devbox", enrolled: false }) });
    expect(await thisComputer(dir)).toEqual({ kind: "none" });
    occupied(dir, { "node/node.json": JSON.stringify({ hub: "http://devbox:4790", machineId: "hubbox", enrolled: true }) });
    expect(await thisComputer(dir)).toEqual({ kind: "node", machineId: "hubbox", hub: "http://devbox:4790" });
    occupied(dir, { "hub/hub.sqlite": "" });
    expect(await thisComputer(dir)).toEqual({ kind: "hub" });
    expect(await thisComputer(dir, "c".repeat(64))).toEqual({ kind: "hub", fingerprint: "c".repeat(64) });
  });

  it("fingerprints this computer as the CLI does", async () => {
    // crates/fleetd/src/fingerprint.rs hashes the same text.
    expect(fingerprintOf("0123456789abcdef0123456789abcdef\n")).toBe(
      createHash("sha256").update("fleetd machine 0123456789abcdef0123456789abcdef").digest("hex"),
    );
    expect(platformUuid('    "IOPlatformSerialNumber" = "C02X"\n    "IOPlatformUUID" = "4C4C4544-0042-3510-8058-B4C04F4D3532"\n')).toBe(
      "4C4C4544-0042-3510-8058-B4C04F4D3532",
    );
    expect(platformUuid("nothing")).toBeUndefined();
    const here = await machineFingerprint("linux");
    if (fs.existsSync("/etc/machine-id")) expect(here).toBe(fingerprintOf(fs.readFileSync("/etc/machine-id", "utf8")));
  });

  it("finds the fleetd dir as the CLI does", () => {
    expect(fleetdDir(undefined, "/home/dev")).toBe("/home/dev/.fleetd");
    expect(fleetdDir("", "/home/dev")).toBe("/home/dev/.fleetd");
    expect(fleetdDir("~", "/home/dev")).toBe("/home/dev");
    expect(fleetdDir("~/fleets/lab", "/home/dev")).toBe("/home/dev/fleets/lab");
    expect(fleetdDir("/srv/fleetd", "/home/dev")).toBe("/srv/fleetd");
    expect(fleetdDir("lab", "/home/dev")).toBe(path.resolve("lab"));
  });

  it("says when the hub's version has no release, and installs nothing", async () => {
    const { p, dir, ran } = ports({ version: "0.9.3" });
    const end = await joinHere({ ...p, download: (url) => Promise.reject(new Error(`${url} answered 404`)) }, "laptop", () => undefined);
    expect(end.state).toBe("failed");
    expect(end.message).toContain("There is no release for v0.9.3, the version the hub runs");
    expect(fs.existsSync(path.join(dir, "bin", "fleetd"))).toBe(false);
    expect(ran).toEqual([]);
  });

  it("shows the join's output when it fails", async () => {
    const { p } = ports({ exit: 1 });
    const end = await joinHere(p, "laptop", () => undefined);
    expect(end.state).toBe("failed");
    expect(end.steps.at(-1)).toEqual({ title: "enroll the node and start its service", state: "failed", output: "joining http://devbox.example.ts.net:4790\nerror: claude is not installed" });
  });

  it("says why when the hub refuses the code", async () => {
    const { p, fetched } = ports({ join: { ok: false, error: { code: "forbidden", message: "Adding machines is for admins.", fix: "Ask one." } } });
    const end = await joinHere(p, "laptop", () => undefined);
    expect(end.message).toBe("Adding machines is for admins. Ask one.");
    expect(fetched).toEqual([]);
  });

  it("names the release asset as the installer does", () => {
    expect(assetFor("darwin", "arm64")).toBe("fleetd-darwin-arm64");
    expect(assetFor("linux", "x64")).toBe("fleetd-linux-x64");
    expect(assetFor("win32", "x64")).toBeUndefined();
    expect(expectedSum(`${SUM} *fleetd-linux-x64\n`, "fleetd-linux-x64")).toBe(SUM);
    expect(expectedSum(`${SUM}  fleetd-linux-x64-old\n`, "fleetd-linux-x64")).toBeUndefined();
  });
});
