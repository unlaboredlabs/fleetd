import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MacJoin } from "../shared/macSetup";
import { cliFailure, findHubs, hubOrigin, joinMac, MacSetup, PANE_URLS, readHealth, redeemMac, tailnetPeers, type MacSetupPorts } from "./macSetup";

const BUILD = new TextEncoder().encode("#!/bin/sh\necho fleetd\n");
const SUM = createHash("sha256").update(BUILD).digest("hex");
const ANSWER = { hubUrl: "http://devbox.example.ts.net:4790", hubName: "devbox", machineId: "mac", token: "fle_token", expiresAt: "x", version: "0.9.0", existing: false };
const TAILSCALE = JSON.stringify({
  Peer: {
    a: { DNSName: "devbox.example.ts.net.", Online: true },
    b: { DNSName: "phone.example.ts.net.", Online: true },
    c: { DNSName: "old.example.ts.net.", Online: false },
  },
});

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A temp fleetd dir, hubs that answer at `hubs` (each with what its /pair/mac says), a tailnet, release files, and a
 * CLI that exits as `exit` says.
 */
function ports(over: { hubs?: Record<string, (body: { code: string; fingerprint?: string }) => Response>; known?: string[]; tailnet?: string; exit?: number; output?: string; node?: object } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-mac-"));
  homes.push(dir);
  if (over.node !== undefined) {
    fs.mkdirSync(path.join(dir, "node"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node", "node.json"), JSON.stringify(over.node));
  }
  const hubs = over.hubs ?? { "http://devbox.example.ts.net:4790": () => json(200, ANSWER) };
  const ran: Array<{ file: string; args: ReadonlyArray<string> }> = [];
  const traded: string[] = [];
  const opened: string[] = [];
  const p: MacSetupPorts = {
    fetch: (url, init) => {
      const origin = new URL(url).origin;
      const answer = hubs[origin];
      if (answer === undefined) return Promise.reject(new TypeError("fetch failed"));
      if (url.endsWith("/healthz")) return Promise.resolve(json(200, { ok: true, version: "0.9.0", protocol: 1 }));
      traded.push(origin);
      return Promise.resolve(answer(JSON.parse(init.body as string) as { code: string }));
    },
    download: (url) => Promise.resolve(url.endsWith("/SHA256SUMS") ? new TextEncoder().encode(`${SUM}  fleetd-darwin-arm64\n`) : BUILD),
    run: (file, args) => {
      ran.push({ file, args });
      return Promise.resolve({ code: over.exit ?? 0, output: over.output ?? "joined\n" });
    },
    fleetdDir: dir,
    fingerprint: () => Promise.resolve("f".repeat(64)),
    baseOverride: undefined,
    platform: "darwin",
    arch: "arm64",
    knownHubs: () => over.known ?? [],
    tailscaleStatus: () => Promise.resolve(over.tailnet ?? TAILSCALE),
    readFile: (file) =>
      Promise.resolve(fs.existsSync(file) ? { text: fs.readFileSync(file, "utf8"), writtenAt: fs.statSync(file).mtimeMs } : undefined),
    openPane: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    now: () => Date.now(),
  };
  return { p, dir, ran, traded, opened };
}

describe("finding the hub", () => {
  it("reads an address as typed, with fleetd's port when none is given", () => {
    expect(hubOrigin("devbox")).toBe("http://devbox:4790");
    expect(hubOrigin(" devbox.example.ts.net:4790/ ")).toBe("http://devbox.example.ts.net:4790");
    expect(hubOrigin("https://hub.example.com")).toBe("https://hub.example.com");
    expect(hubOrigin("")).toBeUndefined();
    expect(hubOrigin("ftp://devbox")).toBeUndefined();
  });

  it("asks the tailnet's online peers, after the hubs the app is signed in to", async () => {
    expect(tailnetPeers(TAILSCALE)).toEqual(["devbox.example.ts.net", "phone.example.ts.net"]);
    expect(tailnetPeers("not json")).toEqual([]);
    const { p } = ports({ known: ["http://lan-hub:4790"], hubs: { "http://lan-hub:4790": () => json(200, ANSWER), "http://devbox.example.ts.net:4790": () => json(200, ANSWER) } });
    expect(await findHubs(p)).toEqual(["http://lan-hub:4790", "http://devbox.example.ts.net:4790"]);
  });
});

describe("trading the code", () => {
  it("finds the hub on the tailnet and trades the code with this Mac's fingerprint, keeping the token from the page", async () => {
    let sent: { code: string; fingerprint?: string } | undefined;
    const { p } = ports({ hubs: { "http://devbox.example.ts.net:4790": (body) => ((sent = body), json(200, ANSWER)) } });
    const { outcome, pending } = await redeemMac(p, { code: "123 456" });
    expect(outcome).toEqual({ ok: true, found: { hubUrl: ANSWER.hubUrl, hubName: "devbox", machineId: "mac", existing: false, here: { kind: "none", fingerprint: "f".repeat(64) } } });
    expect(JSON.stringify(outcome)).not.toContain("fle_token");
    expect(pending?.token).toBe("fle_token");
    expect(sent).toEqual({ code: "123456", fingerprint: "f".repeat(64) });
  });

  it("asks for the address when it finds no hub, and trades only with an address typed", async () => {
    const none = await redeemMac(ports({ tailnet: "{}" }).p, { code: "123456" });
    expect(none.outcome).toMatchObject({ ok: false, failure: { field: "hub" } });
    expect(JSON.stringify(none.outcome)).toContain("shows it under the code");
    const { p, traded } = ports({ hubs: { "http://lan-hub:4790": () => json(200, ANSWER), "http://devbox.example.ts.net:4790": () => json(200, ANSWER) } });
    expect((await redeemMac(p, { code: "123456", hub: "lan-hub" })).outcome.ok).toBe(true);
    expect(traded).toEqual(["http://lan-hub:4790"]);
    const away = await redeemMac(p, { code: "123456", hub: "http://nowhere:4790" });
    expect(away.outcome).toMatchObject({ ok: false, failure: { field: "hub", hub: "http://nowhere:4790" } });
  });

  it("tries every hub it finds, and says the code is open on none of them", async () => {
    const wrong = () => json(401, { code: "pair_code_invalid", message: "that code isn't open on this hub", fix: "Get a new code." });
    const { p, traded } = ports({ known: ["http://lan-hub:4790"], hubs: { "http://lan-hub:4790": wrong, "http://devbox.example.ts.net:4790": wrong } });
    const { outcome } = await redeemMac(p, { code: "123456" });
    expect(traded).toEqual(["http://lan-hub:4790", "http://devbox.example.ts.net:4790"]);
    expect(outcome).toMatchObject({ ok: false, failure: { field: "code" } });
    expect(JSON.stringify(outcome)).toContain("any hub this Mac found");
    const one = await redeemMac(ports({ hubs: { "http://devbox.example.ts.net:4790": wrong } }).p, { code: "123456" });
    expect(one.outcome).toEqual({ ok: false, failure: { message: "That code isn't open on this hub.", fix: "Get a new code.", field: "code" } });
  });

  it("passes on what a hub that refuses the code says to do", async () => {
    const other = () => json(409, { code: "mac_other_computer", message: "this hub's agents' Mac is another computer", fix: "Remove the old one, then type this code again." });
    const { outcome } = await redeemMac(ports({ hubs: { "http://devbox.example.ts.net:4790": other } }).p, { code: "123456" });
    expect(outcome).toEqual({ ok: false, failure: { message: "This hub's agents' Mac is another computer.", fix: "Remove the old one, then type this code again." } });
  });

  it("trades nothing on a Mac that runs a hub, or for a code that isn't six digits", async () => {
    const { p, dir, traded } = ports();
    expect((await redeemMac(p, { code: "12345" })).outcome).toMatchObject({ ok: false, failure: { field: "code" } });
    fs.mkdirSync(path.join(dir, "hub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "hub", "hub.sqlite"), "");
    expect(JSON.stringify((await redeemMac(p, { code: "123456" })).outcome)).toContain("runs a fleetd hub");
    expect(traded).toEqual([]);
  });
});

describe("joining as the agents' Mac", () => {
  const pending = (over: object = {}) => ({ found: { hubUrl: ANSWER.hubUrl, hubName: "devbox", machineId: "mac", existing: false, here: { kind: "none" as const }, ...over }, token: "fle_token", version: "0.9.0" });

  it("installs the hub's build and runs the CLI's join with --mac, and --rejoin when it replaces a node", async () => {
    const { p, dir, ran } = ports();
    const seen: MacJoin[] = [];
    const end = await joinMac(p, pending(), (j) => seen.push(j));
    expect(end.state).toBe("done");
    expect(end.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(ran).toEqual([{ file: path.join(dir, "bin", "fleetd"), args: ["init", "--join", ANSWER.hubUrl, "--code", "fle_token", "--machine-id", "mac", "--mac"] }]);
    expect(seen.some((j) => j.state === "running")).toBe(true);
    await joinMac(p, pending({ existing: true }), () => undefined);
    expect(ran[1]?.args.at(-1)).toBe("--rejoin");
    await joinMac(p, pending({ here: { kind: "node", machineId: "studio", hub: "http://other:4790" } }), () => undefined);
    expect(ran[2]?.args.at(-1)).toBe("--rejoin");
  });

  it("says what the CLI said to do, and that a new code is needed", async () => {
    const output = "checking this Mac\nfleetd: this Mac has no GUI login for ada. Fix: log in to ada at the Mac (or over Screen Sharing), then run it again\n";
    const { p } = ports({ exit: 1, output });
    const end = await joinMac(p, pending(), () => undefined);
    expect(end).toMatchObject({ state: "failed", failure: { message: "This Mac has no GUI login for ada." } });
    expect(end.failure?.fix).toContain("then start again with a new code");
    expect(end.retry).toBeUndefined();
    expect(end.steps.at(-1)?.state).toBe("failed");
    expect(end.steps.at(-1)?.output).toContain("no GUI login");
  });

  it("reads the CLI's last fleetd line, or its last line", () => {
    expect(cliFailure("fleetd: launchctl refused. Fix: log out and in")).toEqual({ message: "Launchctl refused.", fix: "log out and in" });
    expect(cliFailure("fleetd: it stopped")).toEqual({ message: "It stopped." });
    expect(cliFailure("boom\n")).toEqual({ message: "Joining stopped before it finished.", fix: "It said: boom" });
  });

  it("joins once at a time, and keeps an unspent code for another try", async () => {
    const { p } = ports();
    const setup = new MacSetup({ ...p, download: () => Promise.reject(new Error("offline")) }, () => undefined);
    expect((await setup.join()).failure?.message).toContain("no code");
    expect((await setup.redeem({ code: "123456" })).ok).toBe(true);
    const first = setup.join();
    expect(setup.join()).toBe(first);
    expect(await first).toMatchObject({ state: "failed", retry: true });
    expect((await setup.join()).state).toBe("failed");
  });
});

describe("the checks", () => {
  it("reads the node's mac-health.json and whether the hub answers", async () => {
    const { p, dir } = ports();
    expect(await readHealth(p, ANSWER.hubUrl)).toMatchObject({ health: null, writtenAt: null, hubAnswers: true });
    fs.mkdirSync(path.join(dir, "node"), { recursive: true });
    const health = { user: "ada", checks: [{ id: "accessibility", state: "ok", message: "Allowed." }] };
    fs.writeFileSync(path.join(dir, "node", "mac-health.json"), JSON.stringify(health));
    expect(await readHealth(p, "http://nowhere:4790")).toMatchObject({ health, hubAnswers: false });
    fs.writeFileSync(path.join(dir, "node", "mac-health.json"), "{ half");
    expect((await readHealth(p, undefined)).health).toBeNull();
  });

  it("opens Privacy & Security's two panes, and restarts the node with the CLI", async () => {
    const { p, dir, ran, opened } = ports();
    const setup = new MacSetup(p, () => undefined);
    await setup.openPane("accessibility");
    await setup.openPane("screen_recording");
    expect(opened).toEqual([PANE_URLS.accessibility, PANE_URLS.screen_recording]);
    expect(opened[1]).toContain("Privacy_ScreenCapture");
    expect(await setup.restart()).toEqual({ ok: true });
    expect(ran).toEqual([{ file: path.join(dir, "bin", "fleetd"), args: ["node", "restart"] }]);
  });
});
