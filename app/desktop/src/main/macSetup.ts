// "Set up this Mac for agents" (D309, shared/macSetup.ts): main does everything that reaches past the page.
//   1. find the hub: the hubs this app is signed in to, then the tailnet's peers that answer /healthz on fleetd's
//      port; the address the person types, should neither find it;
//   2. this Mac first: a fleetd dir that holds a hub is never touched (nothing is traded for it);
//   3. POST <hub>/pair/mac with the code and this Mac's fingerprint, for a one-time enroll token kept here;
//   4. the hub's own build, checked and put in place, as Add machine's "This computer" does (joinHere installBuild);
//   5. `fleetd init --join <hub> --code <token> --machine-id <id> --mac [--rejoin]`, with no terminal: it enrolls the
//      node and bootstraps its LaunchAgent in this GUI session; a failure's last `fleetd: <why>. Fix: <what>` line is
//      what the page shows;
//   6. then the page reads the node's checks from <fleetd dir>/node/mac-health.json, which the node rewrites after
//      each check (every 2 s while a grant is off), opens the two System Settings panes, and can restart the node.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MacHealth } from "../shared/contracts";
import type { JoinStep, ThisComputer } from "../shared/joinHere";
import type { MacFound, MacHealthRead, MacJoin, MacPane, MacRedeemOutcome, MacRedeemRequest, MacRestartOutcome, MacSetupFailure } from "../shared/macSetup";
import { assetFor, installBuild, thisComputer, type JoinPorts } from "./joinHere";
import { probe, type Fetch } from "./pairing/hubHttp";

/** fleetd's port: a hub on the tailnet is looked for there. */
export const HUB_PORT = 4790;
const FIND_TIMEOUT_MS = 1500;
const TRADE_TIMEOUT_MS = 15_000;
/** Peers asked at once, at most: a big tailnet is asked about its first ones online. */
const MAX_PEERS = 48;

export const PANE_URLS: Readonly<Record<MacPane, string>> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen_recording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export interface MacSetupPorts extends Pick<JoinPorts, "download" | "run" | "fleetdDir" | "fingerprint" | "baseOverride" | "platform" | "arch"> {
  readonly fetch: Fetch;
  /** The addresses of the hubs this app is signed in to. */
  knownHubs(): ReadonlyArray<string>;
  /** `tailscale status --json`'s output, or undefined where there is no Tailscale. */
  tailscaleStatus(): Promise<string | undefined>;
  /** A file's text and when it was last written, or undefined when there is none. */
  readFile(file: string): Promise<{ readonly text: string; readonly writtenAt: number } | undefined>;
  openPane(url: string): Promise<void>;
  now(): number;
}

const TRADE_ANSWER = z.object({
  hubUrl: z.string().min(1),
  hubName: z.string(),
  machineId: z.string().regex(/^[a-z0-9-]{1,32}$/u),
  token: z.string().min(1),
  expiresAt: z.string(),
  version: z.string().min(1),
  existing: z.boolean(),
});
const HUB_FAILURE = z.object({ code: z.string(), message: z.string().min(1), fix: z.string().optional() });

/** An address as typed, as an origin: `devbox` and `devbox:4790` reach http://devbox:4790. Undefined when it can't be one. */
export const hubOrigin = (typed: string): string | undefined => {
  const trimmed = typed.trim().replace(/\/+$/u, "");
  if (trimmed === "") return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.port === "" && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) url.port = String(HUB_PORT);
    return url.origin;
  } catch {
    return undefined;
  }
};

/** The online peers' names in `tailscale status --json` (without their trailing dot), as the hub's own detect reads them. */
export const tailnetPeers = (status: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(status);
  } catch {
    return [];
  }
  const peers = typeof parsed === "object" && parsed !== null ? (parsed as { Peer?: unknown }).Peer : undefined;
  if (typeof peers !== "object" || peers === null) return [];
  const names: string[] = [];
  for (const peer of Object.values(peers as Record<string, unknown>)) {
    if (typeof peer !== "object" || peer === null) continue;
    const { DNSName: name, Online: online } = peer as { DNSName?: unknown; Online?: unknown };
    if (online === true && typeof name === "string" && name !== "") names.push(name.replace(/\.$/u, ""));
  }
  return names.slice(0, MAX_PEERS);
};

/** Every hub this Mac finds by itself: the ones the app is signed in to first, then those on the tailnet. */
export async function findHubs(ports: MacSetupPorts): Promise<string[]> {
  const known = ports.knownHubs().flatMap((url) => hubOrigin(url) ?? []);
  const status = await ports.tailscaleStatus();
  const peers = status === undefined ? [] : tailnetPeers(status).map((name) => `http://${name}:${String(HUB_PORT)}`);
  const asked = await Promise.all(peers.filter((url) => !known.includes(url)).map((url) => probe(ports.fetch, url, FIND_TIMEOUT_MS)));
  return [...new Set([...known, ...asked.filter((p) => p.answers).map((p) => p.hub)])];
}

type Traded = { readonly ok: true; readonly answer: z.infer<typeof TRADE_ANSWER> } | { readonly ok: false; readonly status: number; readonly failure: MacSetupFailure };

async function trade(ports: MacSetupPorts, origin: string, code: string, fingerprint: string | undefined): Promise<Traded> {
  let response: Response;
  try {
    response = await ports.fetch(`${origin}/pair/mac`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, ...(fingerprint === undefined ? {} : { fingerprint }) }),
      signal: AbortSignal.timeout(TRADE_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return {
      ok: false,
      status: 0,
      failure: { message: `Can't reach a hub at ${origin} from this Mac.`, fix: "Check the address under the code on your main machine, and that this Mac is on the same tailnet or network.", field: "hub", hub: origin },
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.ok) {
    const answer = TRADE_ANSWER.safeParse(body);
    if (answer.success) return { ok: true, answer: answer.data };
  }
  if (response.status === 404) {
    return { ok: false, status: 404, failure: { message: `The hub at ${origin} doesn't take Mac setup codes yet.`, fix: "Update fleetd on your main machine (Updates in the app), then get a new code.", field: "hub" } };
  }
  const failure = HUB_FAILURE.safeParse(body);
  if (!failure.success) {
    return { ok: false, status: response.status, failure: { message: `${origin} answered, but not like a fleetd hub.`, fix: "Check the address under the code on your main machine.", field: "hub" } };
  }
  const { message, fix } = failure.data;
  const sentence = message.charAt(0).toUpperCase() + message.slice(1) + (/[.!?]$/u.test(message) ? "" : ".");
  return { ok: false, status: response.status, failure: { message: sentence, ...(fix === undefined ? {} : { fix }), ...(response.status === 401 ? { field: "code" as const } : {}) } };
}

/** The six digits of a code as typed, or undefined. */
export const macCode = (typed: string): string | undefined => {
  const digits = typed.replace(/[\s-]/gu, "");
  return /^\d{6}$/u.test(digits) ? digits : undefined;
};

/** A traded code, kept in main: its token never reaches the page. */
export interface Pending {
  readonly found: MacFound;
  readonly token: string;
  readonly version: string;
}

/**
 * Trades the code with the hub the person typed, or else with each hub this Mac finds until one takes it. A Mac that
 * holds a hub trades nothing.
 */
export async function redeemMac(ports: MacSetupPorts, request: MacRedeemRequest): Promise<{ outcome: MacRedeemOutcome; pending?: Pending }> {
  const failed = (failure: MacSetupFailure) => ({ outcome: { ok: false as const, failure } });
  if (ports.platform !== "darwin") return failed({ message: "The agents' Mac is a Mac: this computer isn't one.", fix: "Open the fleetd app on the Mac that agents will use, and set it up there." });
  const code = macCode(request.code);
  if (code === undefined) return failed({ message: "The code is six digits.", fix: "Type the code Add machine › A Mac for agents shows on your main machine.", field: "code" });
  const fingerprint = await ports.fingerprint();
  const here: ThisComputer = await thisComputer(ports.fleetdDir, fingerprint);
  if (here.kind === "hub") return failed({ message: "This Mac runs a fleetd hub, so it can't be another hub's agents' Mac.", fix: "Set up the agents' Mac on another Mac, or remove this hub first (fleetd uninstall)." });
  let hubs: string[];
  if (request.hub !== undefined && request.hub.trim() !== "") {
    const origin = hubOrigin(request.hub);
    if (origin === undefined) return failed({ message: `${request.hub.trim()} isn't an address.`, fix: "Type the hub's address as Add machine › A Mac for agents shows it, e.g. http://devbox:4790.", field: "hub" });
    hubs = [origin];
  } else {
    hubs = await findHubs(ports);
    if (hubs.length === 0) {
      return failed({ message: "This Mac didn't find your hub by itself.", fix: "Type its address: Add machine › A Mac for agents shows it under the code.", field: "hub" });
    }
  }
  let first: MacSetupFailure | undefined;
  for (const origin of hubs) {
    const traded = await trade(ports, origin, code, fingerprint);
    if (traded.ok) {
      const { answer } = traded;
      const found: MacFound = { hubUrl: answer.hubUrl, hubName: answer.hubName, machineId: answer.machineId, existing: answer.existing, here };
      return { outcome: { ok: true, found }, pending: { found, token: answer.token, version: answer.version } };
    }
    // A hub that knows the code but refuses it (another computer's Mac, too many tries) has the last word.
    if (traded.status !== 401 && traded.status !== 0 && traded.status !== 404) return failed(traded.failure);
    first ??= traded.failure;
  }
  if (hubs.length > 1) {
    return failed({ message: `That code isn't open on any hub this Mac found (${hubs.join(", ")}).`, fix: "Check the six digits, or get a new code from Add machine › A Mac for agents on your main machine.", field: "code" });
  }
  return failed(first ?? { message: "The hub didn't take the code.", field: "code" });
}

/** A node already enrolled here, other than the one this code joins: joining replaces it. */
export const replaces = (found: MacFound): string | undefined =>
  found.here.kind === "node" ? found.here.machineId : found.existing ? found.machineId : undefined;

/** The `fleetd: <why>. Fix: <what>` line the CLI ends a failure with, as a failure; else the output's last line. */
export const cliFailure = (output: string): MacSetupFailure => {
  const lines = output.trim().split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const said = [...lines].reverse().find((l) => l.startsWith("fleetd: "));
  if (said === undefined) {
    return { message: "Joining stopped before it finished.", fix: lines.length === 0 ? "Start again with a new code." : `It said: ${lines[lines.length - 1] ?? ""}` };
  }
  const text = said.slice("fleetd: ".length);
  const at = text.indexOf(" Fix: ");
  const why = (at < 0 ? text : text.slice(0, at)).replace(/\.$/u, "");
  const sentence = `${why.charAt(0).toUpperCase()}${why.slice(1)}.`;
  return at < 0 ? { message: sentence } : { message: sentence, fix: text.slice(at + " Fix: ".length) };
};

const STEP_TITLES = (version: string) => [`download fleetd ${version}, the hub's own`, "check it against the release's checksums", "put it in place", "join the hub and start the node in this login"];

/** Installs the hub's build and joins as the agents' Mac, reporting every change; resolves with how it ended. Never rejects. */
export async function joinMac(ports: MacSetupPorts, pending: Pending, report: (join: MacJoin) => void): Promise<MacJoin> {
  const asset = assetFor(ports.platform, ports.arch);
  if (asset === undefined) {
    const join: MacJoin = { state: "failed", steps: [], failure: { message: `fleetd has no build for this Mac (${ports.arch}).` } };
    report(join);
    return join;
  }
  let steps: JoinStep[] = STEP_TITLES(pending.version).map((title) => ({ title, state: "planned" }));
  let at = -1;
  const send = (join: MacJoin): MacJoin => {
    report(join);
    return join;
  };
  const next = () => {
    at += 1;
    steps = steps.map((s, i) => (i === at ? { title: s.title, state: "running" } : s));
    send({ state: "running", steps });
  };
  const done = () => {
    steps = steps.map((s, i) => (i === at ? { title: s.title, state: "done" } : s));
  };
  const fail = (failure: MacSetupFailure, retry: boolean, output?: string): MacJoin => {
    steps = steps.map((s, i) => (i === at ? { title: s.title, state: "failed", ...(output ? { output } : {}) } : s));
    return send({ state: "failed", steps, failure, ...(retry ? { retry } : {}) });
  };

  const installed = await installBuild(ports, pending.version, asset, { next, done });
  // The token is unspent: the same code tries again.
  if (!installed.ok) return fail({ message: installed.message }, true);

  next();
  const { found } = pending;
  const args = ["init", "--join", found.hubUrl, "--code", pending.token, "--machine-id", found.machineId, "--mac", ...(replaces(found) === undefined ? [] : ["--rejoin"])];
  const ran = await ports.run(installed.bin, args);
  if (ran.code !== 0) {
    const said = cliFailure(ran.output);
    const lines = ran.output.trim().split("\n");
    return fail({ ...said, fix: `${said.fix ?? "Fix that"}, then start again with a new code from your main machine.` }, false, lines.slice(-12).join("\n"));
  }
  done();
  return send({ state: "done", steps });
}

const CHECK = z.object({ id: z.string(), state: z.string(), message: z.string(), fix: z.string().nullish(), command: z.string().nullish() });
const HEALTH = z.object({ user: z.string(), checks: z.array(CHECK) });

/** The node's checks, as it last wrote them, and whether the hub answers. */
export async function readHealth(ports: MacSetupPorts, hubUrl: string | undefined): Promise<MacHealthRead> {
  const [file, answers] = await Promise.all([
    ports.readFile(path.join(ports.fleetdDir, "node", "mac-health.json")),
    hubUrl === undefined ? Promise.resolve(false) : probe(ports.fetch, hubUrl, FIND_TIMEOUT_MS).then((p) => p.answers),
  ]);
  let health: MacHealth | null = null;
  if (file !== undefined) {
    try {
      const parsed = HEALTH.safeParse(JSON.parse(file.text));
      if (parsed.success) health = parsed.data as MacHealth;
    } catch {
      // Half-written: the next read has it.
    }
  }
  return { health, writtenAt: file?.writtenAt ?? null, now: ports.now(), hubAnswers: answers };
}

/** `fleetd node restart`: launchd starts the node again in this login. */
export async function restartNode(ports: MacSetupPorts): Promise<MacRestartOutcome> {
  const ran = await ports.run(path.join(ports.fleetdDir, "bin", "fleetd"), ["node", "restart"]);
  return ran.code === 0 ? { ok: true } : { ok: false, failure: cliFailure(ran.output) };
}

/** One setup at a time, as there is one fleetd dir here: the traded code, and the join running or last ended. */
export class MacSetup {
  #pending: Pending | undefined;
  #join: Promise<MacJoin> | undefined;
  readonly #ports: MacSetupPorts;
  readonly #report: (join: MacJoin) => void;

  constructor(ports: MacSetupPorts, report: (join: MacJoin) => void) {
    this.#ports = ports;
    this.#report = report;
  }

  async redeem(request: MacRedeemRequest): Promise<MacRedeemOutcome> {
    if (this.#join !== undefined) return { ok: false, failure: { message: "This Mac is joining already." } };
    const { outcome, pending } = await redeemMac(this.#ports, request);
    this.#pending = pending;
    return outcome;
  }

  /** Joins with the traded code; asked again while it runs, the same join. */
  join(): Promise<MacJoin> {
    if (this.#join !== undefined) return this.#join;
    const pending = this.#pending;
    if (pending === undefined) return Promise.resolve({ state: "failed", steps: [], failure: { message: "There is no code to join with.", fix: "Type the code again." } });
    const run = joinMac(this.#ports, pending, this.#report).then((join) => {
      this.#join = undefined;
      // Spent, or on to a new code: only a failure before the join keeps it.
      if (join.state === "done" || join.retry !== true) this.#pending = undefined;
      return join;
    });
    this.#join = run;
    return run;
  }

  health(hubUrl: string | undefined): Promise<MacHealthRead> {
    return readHealth(this.#ports, hubUrl);
  }

  openPane(pane: MacPane): Promise<void> {
    return this.#ports.openPane(PANE_URLS[pane]);
  }

  restart(): Promise<MacRestartOutcome> {
    return restartNode(this.#ports);
  }
}

/** Where the Tailscale CLI is on a Mac: on PATH, or inside the App Store app. */
const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

export const realMacPorts = (join: Pick<JoinPorts, "download" | "run" | "fleetdDir" | "fingerprint" | "baseOverride" | "platform" | "arch">, extra: { knownHubs: () => ReadonlyArray<string>; openPane: (url: string) => Promise<void> }): MacSetupPorts => ({
  ...join,
  fetch: (url, init) => fetch(url, init),
  knownHubs: extra.knownHubs,
  openPane: extra.openPane,
  tailscaleStatus: async () => {
    for (const cli of TAILSCALE) {
      const ran = await join.run(cli, ["status", "--json"]);
      if (ran.code === 0) return ran.output;
    }
    return undefined;
  },
  readFile: async (file) => {
    try {
      const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      return { text, writtenAt: stat.mtimeMs };
    } catch {
      return undefined;
    }
  },
  now: () => Date.now(),
});
