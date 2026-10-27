import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallOutcome } from "../shared/hub";
import type { JoinHere } from "../shared/joinHere";
import { assetFor, expectedSum, joinHere, type JoinPorts } from "./joinHere";

const BUILD = new TextEncoder().encode("#!/bin/sh\necho fleetd\n");
const SUM = createHash("sha256").update(BUILD).digest("hex");
const CODE = "fle_onetimecode";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** A temp fleetd dir, a hub that answers machine_join, release files and a CLI that does what `exit` says. */
function ports(over: { sums?: string; exit?: number; join?: CallOutcome } = {}) {
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
          : { ok: true, output: { version: "0.9.0-nightly.20261020" } },
      ),
    download: (url) => {
      fetched.push(url);
      return Promise.resolve(url.endsWith("/SHA256SUMS") ? new TextEncoder().encode(over.sums ?? `${SUM}  fleetd-linux-x64\n${"0".repeat(64)}  fleetd-darwin-arm64\n`) : BUILD);
    },
    run: (file, args) => {
      ran.push({ file, args });
      return Promise.resolve({ code: over.exit ?? 0, output: over.exit ? "joining http://devbox.example.ts.net:4790\nerror: claude is not installed\n" : "joined\n" });
    },
    fleetdDir: dir,
    baseOverride: undefined,
    platform: "linux",
    arch: "x64",
  };
  return { p, dir, ran, fetched };
}

describe("joining this computer", () => {
  it("downloads the hub's channel's build, checks it, installs it and runs fleetd init --join", async () => {
    const { p, dir, ran, fetched } = ports();
    const seen: JoinHere[] = [];
    const end = await joinHere(p, "laptop", (s) => seen.push(s));
    expect(end.state).toBe("done");
    expect(end.steps.every((s) => s.state === "done")).toBe(true);
    expect(fetched).toEqual([
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
    expect(seen.map((s) => s.steps.findIndex((x) => x.state === "running"))).toEqual([0, 1, 2, 3, 4, -1]);
    expect(JSON.stringify(seen)).not.toContain(CODE);
  });

  it("installs nothing when the build doesn't match SHA256SUMS", async () => {
    const { p, dir, ran } = ports({ sums: `${"a".repeat(64)}  fleetd-linux-x64\n` });
    const end = await joinHere(p, "laptop", () => undefined);
    expect(end.state).toBe("failed");
    expect(end.steps.map((s) => s.state)).toEqual(["done", "done", "failed", "planned", "planned"]);
    expect(end.message).toContain("doesn't match SHA256SUMS");
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
