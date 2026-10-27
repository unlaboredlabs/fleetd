// "This computer" in Add machine: main makes the computer the app runs on a machine of its hub, as the installer's
// join line (site/install.sh --join) does, with the CLI's own join (`fleetd init --join`) doing the rest:
//   1. machine_join: a one-time code from the hub, asked by main, so the code never reaches the page;
//   2. the hub's release build for this OS and CPU (its channel, as `fleetd update` picks it), and SHA256SUMS;
//   3. the build checked against SHA256SUMS: a mismatch installs nothing;
//   4. put in place as <fleetd dir>/bin/fleetd by renaming, never by writing into a running binary;
//   5. `fleetd init --join <hub> --code <code> --machine-id <id>`: it enrolls the node and runs it as a user service.
// The page then waits for the machine to come online, from the hub's own events.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolInput } from "../shared/contracts";
import type { CallOutcome } from "../shared/hub";
import type { JoinHere, JoinStep } from "../shared/joinHere";
import { feedUrl } from "./update-feed";

export interface JoinPorts {
  /** A hub call, as the page's go through main. */
  call<T extends "machine_join" | "hub_info">(tool: T, input: ToolInput<T>): Promise<CallOutcome>;
  /** The body of a URL, or an error that says why not. */
  download(url: string): Promise<Uint8Array>;
  /** Runs the CLI with no terminal; its exit code and everything it printed. */
  run(file: string, args: ReadonlyArray<string>): Promise<{ code: number; output: string }>;
  /** The fleetd dir: FLEETD_HOME, else ~/.fleetd, as the CLI has it. */
  fleetdDir: string;
  /** FLEETD_BASE_URL, for a lab's own release files. */
  baseOverride: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
}

export const realPorts = (call: JoinPorts["call"]): JoinPorts => ({
  call,
  download: async (url) => {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  run: (file, args) =>
    new Promise((done) => {
      const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-20_000);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.once("error", (error) => done({ code: 127, output: String(error) }));
      child.once("close", (code) => done({ code: code ?? 1, output }));
    }),
  fleetdDir: process.env["FLEETD_HOME"] ?? path.join(os.homedir(), ".fleetd"),
  baseOverride: process.env["FLEETD_BASE_URL"],
  platform: process.platform,
  arch: process.arch,
});

const TITLES = {
  code: "get a one-time code from the hub",
  download: (asset: string) => `download ${asset}`,
  check: "check it against the release's SHA256SUMS",
  install: "put it in place",
  join: "enroll the node and start its service",
} as const;

/** The release asset for this computer, as the installer names it; undefined where fleetd has no build. */
export const assetFor = (platform: NodeJS.Platform, arch: string): string | undefined => {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  return os && cpu ? `fleetd-${os}-${cpu}` : undefined;
};

/** The line of SHA256SUMS for `asset` (`<hex>  <name>`, or `<hex> *<name>`). */
export const expectedSum = (sums: string, asset: string): string | undefined => {
  for (const line of sums.split("\n")) {
    const [hex, name] = line.trim().split(/\s+/u);
    if (hex !== undefined && (name === asset || name === `*${asset}`) && /^[0-9a-f]{64}$/u.test(hex)) return hex;
  }
  return undefined;
};

const lastLines = (text: string, n = 15): string => text.trim().split("\n").slice(-n).join("\n");

const str = (o: unknown, key: string): string | undefined => {
  const v = typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : undefined;
};

/** Joins this computer to the hub as `machineId`, reporting every change; resolves with how it ended. Never rejects. */
export async function joinHere(ports: JoinPorts, machineId: string, report: (state: JoinHere) => void): Promise<JoinHere> {
  const asset = assetFor(ports.platform, ports.arch);
  const titles = [TITLES.code, TITLES.download(asset ?? "fleetd"), TITLES.check, TITLES.install, TITLES.join];
  let steps: JoinStep[] = titles.map((title) => ({ title, state: "planned" }));
  let at = -1;
  const send = (state: JoinHere["state"], message?: string): JoinHere => {
    const out: JoinHere = { machineId, state, steps, ...(message === undefined ? {} : { message }) };
    report(out);
    return out;
  };
  const next = () => {
    at += 1;
    steps = steps.map((s, i) => (i === at ? { title: s.title, state: "running" } : s));
    send("running");
  };
  const done = (output?: string) => {
    steps = steps.map((s, i) => (i === at ? { title: s.title, state: "done", ...(output ? { output } : {}) } : s));
  };
  const fail = (message: string, output?: string): JoinHere => {
    steps = steps.map((s, i) => (i === at ? { title: s.title, state: "failed", ...(output ? { output } : {}) } : s));
    return send("failed", message);
  };

  next();
  if (asset === undefined) return fail(`fleetd has no build for ${ports.platform} on ${ports.arch}: it runs on macOS and Linux, x64 or arm64.`);
  const [joined, info] = await Promise.all([ports.call("machine_join", { machineId }), ports.call("hub_info", {})]);
  if (!joined.ok) return fail(joined.error.fix ? `${joined.error.message} ${joined.error.fix}` : joined.error.message);
  const hub = str(joined.output, "hubUrl");
  const code = str(joined.output, "code");
  if (hub === undefined || code === undefined) return fail("The hub's answer had no address or code. Update the hub, then try again.");
  const identity = str(joined.output, "gitIdentity");
  done();

  next();
  const base = feedUrl((info.ok ? str(info.output, "version") : undefined) ?? "", ports.baseOverride);
  let sums: string;
  let build: Uint8Array;
  try {
    sums = new TextDecoder().decode(await ports.download(`${base}/SHA256SUMS`));
    build = await ports.download(`${base}/${asset}`);
  } catch (error) {
    return fail(`Couldn't download fleetd: ${error instanceof Error ? error.message : String(error)}. Check this computer's connection, then try again.`);
  }
  done();

  next();
  const expected = expectedSum(sums, asset);
  const actual = createHash("sha256").update(build).digest("hex");
  if (expected === undefined) return fail(`The release lists no ${asset}, so there is nothing to check it against; nothing was installed.`);
  if (expected !== actual) return fail(`${asset} doesn't match SHA256SUMS (expected ${expected}, got ${actual}); nothing was installed.`);
  done();

  next();
  const binDir = path.join(ports.fleetdDir, "bin");
  const bin = path.join(binDir, "fleetd");
  try {
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(`${bin}.new`, build, { mode: 0o755 });
    await fs.rename(`${bin}.new`, bin);
  } catch (error) {
    return fail(`Couldn't put fleetd in ${binDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  done(bin);

  next();
  const args = ["init", "--join", hub, "--code", code, "--machine-id", machineId, ...(identity ? ["--git-identity", identity] : [])];
  const ran = await ports.run(bin, args);
  if (ran.code !== 0) {
    return fail(`fleetd init --join stopped (exit ${ran.code}). Its output says why; once that's fixed, try again for a new code.`, lastLines(ran.output));
  }
  done();
  return send("done");
}
