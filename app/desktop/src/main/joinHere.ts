// "This computer" in Add machine: main makes the computer the app runs on a machine of its hub, as the installer's
// join line (site/install.sh --join) does, with the CLI's own join (`fleetd init --join`) doing the rest:
//   0. this computer's fleetd dir, read first: one that holds a hub, or a node already enrolled (under any id), is
//      never touched, as its bin/fleetd is the one that hub or node runs (thisComputer);
//   1. machine_join: a one-time code from the hub, asked by main, so the code never reaches the page;
//   2. the build of the hub's own version for this OS and CPU (its v<version> release; an Edge hub, the edge release
//      only while that is its version), and SHA256SUMS;
//   3. the build checked against SHA256SUMS: a mismatch installs nothing;
//   4. put in place as <fleetd dir>/bin/fleetd by renaming, never by writing into a running binary;
//   5. `fleetd init --join <hub> --code <code> --machine-id <id>`: it enrolls the node and runs it as a user service.
// The page then waits for the machine to come online, from the hub's own events.
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolInput } from "../shared/contracts";
import type { CallOutcome } from "../shared/hub";
import type { JoinHere, JoinStep, ThisComputer } from "../shared/joinHere";
import { isEdge } from "../shared/pairing";
import { feedUrl } from "./update-feed";
import { parseCli } from "./update-release";

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

/**
 * The fleetd dir as the CLI resolves it (crates/fleetd/src/home.rs): FLEETD_HOME unless empty, with `~` expanded and
 * a relative path taken against the working directory, else ~/.fleetd.
 */
export const fleetdDir = (env: string | undefined = process.env["FLEETD_HOME"], home: string = os.homedir()): string => {
  if (env === undefined || env === "") return path.join(home, ".fleetd");
  if (env === "~") return home;
  return path.resolve(env.startsWith("~/") ? path.join(home, env.slice(2)) : env);
};

function str(o: unknown, key: string): string | undefined {
  const v = typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : undefined;
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
  fleetdDir: fleetdDir(),
  baseOverride: process.env["FLEETD_BASE_URL"],
  platform: process.platform,
  arch: process.arch,
});

const TITLES = {
  look: "check that this computer isn't part of a hub yet",
  code: "get a one-time code from the hub",
  download: (asset: string) => `download ${asset}`,
  check: "check it against the release's SHA256SUMS",
  install: "put it in place",
  join: "enroll the node and start its service",
} as const;

const RELEASES = "https://github.com/unlaboredlabs/fleetd/releases/download";

/**
 * Where the build of the hub's `version` is: its own `v<version>` release, or for an Edge hub the rolling edge release
 * (whose release.json must still name that version). FLEETD_BASE_URL, when it is trusted, replaces both.
 */
export const releaseFor = (version: string, override: string | undefined): { base: string; edge: boolean } => {
  if (override !== undefined && feedUrl(version, override) === override) return { base: override, edge: false };
  const edge = isEdge(version);
  return { base: edge ? `${RELEASES}/edge` : `${RELEASES}/v${version}`, edge };
};

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/** The fingerprint of an OS machine id, as the CLI makes it (crates/fleetd/src/fingerprint.rs `of`). */
export const fingerprintOf = (osId: string): string => createHash("sha256").update(`fleetd machine ${osId.trim()}`).digest("hex");

/** `"IOPlatformUUID" = "…"` in `ioreg -rd1 -c IOPlatformExpertDevice`. */
export const platformUuid = (ioreg: string): string | undefined => /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(ioreg)?.[1];

/** This computer's fingerprint: from /etc/machine-id on Linux, IOPlatformUUID on macOS; undefined where there is none. */
export const machineFingerprint = async (platform: NodeJS.Platform = process.platform): Promise<string | undefined> => {
  let id: string | undefined;
  if (platform === "darwin") {
    id = await new Promise<string | undefined>((done) => {
      execFile("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], (error, stdout) => done(error === null ? platformUuid(stdout) : undefined));
    });
  } else {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      id = await fs.readFile(file, "utf8").catch(() => undefined);
      if (id !== undefined) break;
    }
  }
  const trimmed = id?.trim();
  return trimmed ? fingerprintOf(trimmed) : undefined;
};

/**
 * What this computer's fleetd dir holds: a hub's home (`hub/hub.sqlite` or `fleetd init`'s `hub/setup.json`), a node
 * enrolled with a hub (`node/node.json`, under whatever id), or neither, with this computer's `fingerprint`. Read
 * before anything is downloaded.
 */
export const thisComputer = async (fleetdDir: string, fingerprint?: string): Promise<ThisComputer> => {
  const hubHome = path.join(fleetdDir, "hub");
  const fp = fingerprint === undefined ? {} : { fingerprint };
  if ((await exists(path.join(hubHome, "hub.sqlite"))) || (await exists(path.join(hubHome, "setup.json")))) return { kind: "hub", ...fp };
  let node: unknown;
  try {
    node = JSON.parse(await fs.readFile(path.join(fleetdDir, "node", "node.json"), "utf8"));
  } catch {
    return { kind: "none", ...fp };
  }
  const enrolled = typeof node === "object" && node !== null && (node as Record<string, unknown>)["enrolled"] === true;
  const machineId = str(node, "machineId");
  return enrolled && machineId !== undefined ? { kind: "node", machineId, hub: str(node, "hub") ?? "", ...fp } : { kind: "none", ...fp };
};

/** Why `here` is never joined from the app. */
export const refusal = (here: ThisComputer): string | undefined =>
  here.kind === "hub"
    ? "This computer runs the hub, so the hub sets up its node itself, with its own fleetd; nothing was changed here."
    : here.kind === "node"
      ? `This computer is already part of ${here.hub === "" ? "a hub" : `the hub at ${here.hub}`} as ${here.machineId}; nothing was changed.`
      : undefined;

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

/** Joins this computer to the hub as `machineId`, reporting every change; resolves with how it ended. Never rejects. */
export async function joinHere(ports: JoinPorts, machineId: string, report: (state: JoinHere) => void): Promise<JoinHere> {
  const asset = assetFor(ports.platform, ports.arch);
  const titles = [TITLES.look, TITLES.code, TITLES.download(asset ?? "fleetd"), TITLES.check, TITLES.install, TITLES.join];
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
  // Its bin/fleetd is what a hub or a node here runs: never replaced, and never enrolled a second time.
  const why = refusal(await thisComputer(ports.fleetdDir));
  if (why !== undefined) return fail(why);
  done();

  next();
  const [joined, info] = await Promise.all([ports.call("machine_join", { machineId }), ports.call("hub_info", {})]);
  if (!joined.ok) return fail(joined.error.fix ? `${joined.error.message} ${joined.error.fix}` : joined.error.message);
  const hub = str(joined.output, "hubUrl");
  const code = str(joined.output, "code");
  if (hub === undefined || code === undefined) return fail("The hub's answer had no address or code. Update the hub, then try again.");
  const identity = str(joined.output, "gitIdentity");
  const version = info.ok ? str(info.output, "version") : undefined;
  if (version === undefined) return fail("The hub didn't say which fleetd it runs, so there is no build to match it. Try again once it answers.");
  done();

  next();
  const { base, edge } = releaseFor(version, ports.baseOverride);
  let sums: string;
  let build: Uint8Array;
  try {
    if (edge) {
      // The edge release moves on; a node must run the hub's own build.
      const now = parseCli(JSON.parse(new TextDecoder().decode(await ports.download(`${base}/release.json`))));
      if (now !== version) {
        return fail(
          `The hub runs ${version}, and the edge release is now ${now ?? "another build"}. Update the hub first (Updates in the app, or fleetd update on the hub), then add this computer: both then run the same build.`,
        );
      }
    }
    try {
      sums = new TextDecoder().decode(await ports.download(`${base}/SHA256SUMS`));
    } catch (error) {
      // A hub built from source runs a version no release was made for.
      if (!edge && base.startsWith(RELEASES) && String(error).includes("answered 404")) {
        return fail(`There is no release for v${version}, the version the hub runs (a build from source?), so there is no build to match it. Run a released fleetd on the hub, then try again.`);
      }
      throw error;
    }
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
