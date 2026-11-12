// "Set up this Mac for agents" (D309, shared/macSetup.ts): main does everything that reaches past the page.
//   1. find the hub, without the code: the hubs this app is signed in to and the tailnet's peers that answer /healthz
//      on fleetd's port. One found is the hub; several, the person picks theirs; none, they type its address. The code
//      goes to that one hub only;
//   2. this Mac first: a fleetd dir that holds a hub is never touched (nothing is traded for it);
//   3. POST <hub>/pair/mac with the code and this Mac's fingerprint, for a one-time enroll token kept here;
//   4. the hub's own build, checked and put in place, as Add machine's "This computer" does (joinHere installBuild);
//   5. `fleetd init --join <hub> --code <token> --machine-id <id> --mac [--rejoin]`, with no terminal: it enrolls the
//      node and bootstraps its LaunchAgent in this GUI session; a failure's last `fleetd: <why>. Fix: <what>` line is
//      what the page shows;
//   6. then the page reads the node's checks from <fleetd dir>/node/mac-health.json, which the node rewrites after
//      each run of every check (touching mac-health.checked) and after each read of the grants (every 2 s while one is
//      off), has the node ask macOS for each grant (`fleetd node grants --ask`, which then opens its System Settings
//      pane with fleetd in the list: only the node's own ask puts fleetd there, not the app's), and can restart it.
// A version difference never stops it: the Mac installs the hub's own build and channel, or once the edge release has
// moved on past the hub's build, the newer one it holds. The page then says the hub is behind, with its Update right
// there for an admin signed in on this Mac (hubRole, updateHub). An app too old for the hub's answer says so, with
// its own Update.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MacHealth } from "../shared/contracts";
import type { JoinStep, ThisComputer } from "../shared/joinHere";
import { administers, serves, type CallOutcome } from "../shared/hub";
import { HUB_UPDATE_WHERE, type HubBehind, type MacFound, type MacHealthRead, type MacHubUpdateOutcome, type MacJoin, type MacPane, type MacRedeemOutcome, type MacRedeemRequest, type MacRestartOutcome, type MacSetupFailure, type MacSetupStatus } from "../shared/macSetup";
import type { MacActivity, MacBehind, MacDisk, MacMenuBarRead } from "../shared/macMenuBar";
import { compareVersions, isEdge } from "../shared/pairing";
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
  // The node's Xcode check gives the same link (agents_mac/xcode.rs).
  app_store: "macappstore://apps.apple.com/app/id497799835",
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
  /** Who this app is on the hub at `hubUrl`: signed in as an admin (or owner), as a member, or not signed in there. */
  hubRole(hubUrl: string): Promise<HubBehind["who"]>;
  /** Starts the hub's own update (hub_update) with this app's key for it: an admin's only. */
  updateHub(hubUrl: string): Promise<MacHubUpdateOutcome>;
  /** The free and whole space of the disk `dir` is on; undefined when it can't be read. */
  disk(dir: string): Promise<MacDisk | undefined>;
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
    // The hub took the code, in words this app doesn't know yet: a newer hub's. The code is spent; a new one works once
    // the app is updated.
    return { ok: false, status: response.status, failure: APP_BEHIND };
  }
  if (response.status === 404) {
    return { ok: false, status: 404, failure: { message: `The hub at ${origin} runs an older fleetd that doesn't take Mac setup codes yet.`, fix: `${HUB_UPDATE_WHERE} Then get a new code.`, field: "hub" } };
  }
  const failure = HUB_FAILURE.safeParse(body);
  if (!failure.success) {
    return { ok: false, status: response.status, failure: { message: `${origin} answered, but not like a fleetd hub.`, fix: "Check the address under the code on your main machine.", field: "hub" } };
  }
  const { message, fix } = failure.data;
  const sentence = message.charAt(0).toUpperCase() + message.slice(1) + (/[.!?]$/u.test(message) ? "" : ".");
  return { ok: false, status: response.status, failure: { message: sentence, ...(fix === undefined ? {} : { fix }), ...(response.status === 401 ? { field: "code" as const } : {}) } };
}

/** This app is older than the hub: its own update is the fix, offered on the page. */
export const APP_BEHIND: MacSetupFailure = {
  message: "This app is older than your hub, so it can't set up this Mac.",
  fix: "Update the app, then type a new code from Add machine › A Mac for agents.",
  updateApp: true,
};

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
  /** When the token stops working (RFC 3339). */
  readonly expiresAt: string;
}

/**
 * Trades the code with the hub the person typed or picked, or else the one hub this Mac finds. It never sends the code
 * to more than one: found several, it lists them for the person to pick, sending none. A Mac that holds a hub trades
 * nothing.
 */
export async function redeemMac(ports: MacSetupPorts, request: MacRedeemRequest): Promise<{ outcome: MacRedeemOutcome; pending?: Pending }> {
  const failed = (failure: MacSetupFailure) => ({ outcome: { ok: false as const, failure } });
  if (ports.platform !== "darwin") return failed({ message: "The agents' Mac is a Mac: this computer isn't one.", fix: "Open the fleetd app on the Mac that agents will use, and set it up there." });
  const code = macCode(request.code);
  if (code === undefined) return failed({ message: "The code is six digits.", fix: "Type the code Add machine › A Mac for agents shows on your main machine.", field: "code" });
  const fingerprint = await ports.fingerprint();
  const here: ThisComputer = await thisComputer(ports.fleetdDir, fingerprint);
  if (here.kind === "hub") return failed({ message: "This Mac runs a fleetd hub, so it can't be another hub's agents' Mac.", fix: "Set up the agents' Mac on another Mac, or remove this hub first (fleetd uninstall)." });
  // The code goes to one hub only: the one typed, or the one this Mac found. Found several, it asks which, sending none.
  let hub: string;
  if (request.hub !== undefined && request.hub.trim() !== "") {
    const origin = hubOrigin(request.hub);
    if (origin === undefined) return failed({ message: `${request.hub.trim()} isn't an address.`, fix: "Type the hub's address as Add machine › A Mac for agents shows it, e.g. http://devbox:4790.", field: "hub" });
    hub = origin;
  } else {
    const hubs = await findHubs(ports);
    const [only] = hubs;
    if (only === undefined) {
      return failed({ message: "This Mac didn't find your hub by itself.", fix: "Type its address: Add machine › A Mac for agents shows it under the code.", field: "hub" });
    }
    if (hubs.length > 1) {
      return failed({
        message: `This Mac found ${String(hubs.length)} hubs. Which is yours?`,
        fix: "Its address is under the code on your main machine. The code goes to that hub only.",
        field: "hub",
        choices: hubs,
      });
    }
    hub = only;
  }
  const traded = await trade(ports, hub, code, fingerprint);
  if (!traded.ok) return failed(traded.failure);
  const { answer } = traded;
  const found: MacFound = { hubUrl: answer.hubUrl, hubName: answer.hubName, machineId: answer.machineId, existing: answer.existing, here };
  return { outcome: { ok: true, found }, pending: { found, token: answer.token, version: answer.version, expiresAt: answer.expiresAt } };
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

const STEP_TITLES = (version: string) => [
  isEdge(version) ? "download the hub's own fleetd, an edge build" : `download fleetd ${version}, the hub's own`,
  "check it against the release's checksums",
  "put it in place",
  "join the hub and start the node in this login",
];
/** The first step once the edge release had moved on past the hub's build. */
const NEWER_TITLE = "download the newest edge fleetd, newer than the hub's";
/** How `fleetd init --join` begins its refusal of a hub on an older link protocol (crate::protocol_behind). */
const HUB_PROTOCOL_BEHIND = "The hub runs an older fleetd than this machine";

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

  // The edge release moved on past the hub's build: the first step says so as soon as it is known, while it downloads.
  const newer = (version: string) => {
    if (version === pending.version) return;
    steps = steps.map((s, i) => (i === 0 ? { ...s, title: NEWER_TITLE } : s));
    send({ state: "running", steps });
  };
  const installed = await installBuild(ports, pending.version, asset, { next, done, newer });
  // The token is unspent: the same code tries again.
  if (!installed.ok) return fail({ message: installed.message }, true);

  next();
  const { found } = pending;
  const args = ["init", "--join", found.hubUrl, "--code", pending.token, "--machine-id", found.machineId, "--mac", ...(replaces(found) === undefined ? [] : ["--rejoin"])];
  const ran = await ports.run(installed.bin, args);
  if (ran.code !== 0) {
    const said = cliFailure(ran.output);
    const lines = ran.output.trim().split("\n");
    // Refused before it enrolled, so the token is unspent: once the hub is updated, the same code joins.
    if (said.message.startsWith(HUB_PROTOCOL_BEHIND)) {
      return fail({ message: "Your hub runs an older fleetd than this Mac, so this Mac can't join it yet.", fix: `${HUB_UPDATE_WHERE} Then press Try again: the same code still works.` }, true);
    }
    return fail({ ...said, fix: `${said.fix ?? "Fix that"}, then start again with a new code from your main machine.` }, false, lines.slice(-12).join("\n"));
  }
  done();
  return send({ state: "done", steps });
}

const CHECK = z.object({ id: z.string(), state: z.string(), message: z.string(), fix: z.string().nullish(), command: z.string().nullish() });
const HEALTH = z.object({ user: z.string(), checks: z.array(CHECK) });

/**
 * The node's checks, as it last wrote them, when it last ran them all, whether the hub answers, and whether it runs an
 * older fleetd than the node: the build the node last linked with, as it writes it on each welcome (node/update/up).
 * `role` says who this app is on that hub.
 */
export async function readHealth(ports: MacSetupPorts, hubUrl: string | undefined, role: (hubUrl: string) => Promise<HubBehind["who"]> = (hub) => ports.hubRole(hub)): Promise<MacHealthRead> {
  const node = path.join(ports.fleetdDir, "node");
  const [file, checked, hub, up] = await Promise.all([
    ports.readFile(path.join(node, "mac-health.json")),
    ports.readFile(path.join(node, "mac-health.checked")),
    hubUrl === undefined ? Promise.resolve(undefined) : probe(ports.fetch, hubUrl, FIND_TIMEOUT_MS),
    ports.readFile(path.join(node, "update", "up")),
  ]);
  const answers = hub?.answers === true;
  const macVersion = up?.text.trim() ?? "";
  let hubBehind: HubBehind | null = null;
  let macBehind: MacBehind | null = null;
  if (hub?.answers === true && hubUrl !== undefined && compareVersions(macVersion, "0.0.0") !== 0) {
    const order = compareVersions(macVersion, hub.version);
    if (order === 1) hubBehind = { hubVersion: hub.version, macVersion, who: await role(hubUrl) };
    if (order === -1) macBehind = { hubVersion: hub.version, macVersion, who: await role(hubUrl) };
  }
  let health: MacHealth | null = null;
  if (file !== undefined) {
    try {
      const parsed = HEALTH.safeParse(JSON.parse(file.text));
      if (parsed.success) health = parsed.data as MacHealth;
    } catch {
      // Half-written: the next read has it.
    }
  }
  return { health, writtenAt: file?.writtenAt ?? null, checkedAt: checked?.writtenAt ?? null, now: ports.now(), hubAnswers: answers, hubBehind, macBehind };
}

const SIM = z.object({ agent: z.string(), projectId: z.string(), device: z.string(), sinceMs: z.number() });
const JOB = z.object({ agent: z.string(), projectId: z.string(), job: z.number(), command: z.string(), startedMs: z.number() });
const ACTIVITY = z.object({ simulators: z.array(SIM), jobs: z.array(JOB) });

/** The node's mac-activity.json (node/mac_tool/activity.rs), or null when it isn't there or can't be read. */
export const parseActivity = (text: string | undefined): MacActivity | null => {
  if (text === undefined) return null;
  try {
    const parsed = ACTIVITY.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    // Half-written: the next read has it.
    return null;
  }
};

/** How long the CLI waits for the node to take the ask: it reads it every 2 s while a grant is off. */
export const ASK_WAIT_S = 5;

/**
 * `fleetd node grants --ask <grant>`: the running node asks macOS for it within 2 s, and the pane opens either way.
 * A node that didn't take the ask in time isn't running: the page says so, with its Restart.
 */
export async function askGrant(ports: MacSetupPorts, grant: "accessibility" | "screen_recording"): Promise<MacRestartOutcome> {
  const ran = await ports.run(path.join(ports.fleetdDir, "bin", "fleetd"), ["node", "grants", "--ask", grant, "--wait", String(ASK_WAIT_S), "--home", path.join(ports.fleetdDir, "node")]);
  if (ran.code === 0) return { ok: true };
  return { ok: false, failure: { message: cliFailure(ran.output).message, fix: "Restart the node: it asks macOS once it runs." } };
}

/** `fleetd node restart`: launchd starts the node again in this login. */
export async function restartNode(ports: MacSetupPorts): Promise<MacRestartOutcome> {
  const ran = await ports.run(path.join(ports.fleetdDir, "bin", "fleetd"), ["node", "restart"]);
  return ran.code === 0 ? { ok: true } : { ok: false, failure: cliFailure(ran.output) };
}

/** This Mac's node as node.json has it, when it is enrolled as the agents' Mac: what the window reopens on. */
export async function joinedHere(ports: MacSetupPorts): Promise<MacFound | undefined> {
  const file = await ports.readFile(path.join(ports.fleetdDir, "node", "node.json"));
  let node: unknown;
  try {
    node = JSON.parse(file?.text ?? "null");
  } catch {
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const { enrolled, agentsMac, machineId, hub } = node as Record<string, unknown>;
  if (enrolled !== true || agentsMac !== true || typeof machineId !== "string" || typeof hub !== "string") return undefined;
  let hubName = hub;
  try {
    hubName = new URL(hub).hostname.split(".")[0] ?? hub;
  } catch {
    // An address with no scheme: shown as it is.
  }
  return { hubUrl: hub, hubName, machineId, existing: true, here: { kind: "node", machineId, hub } };
}

/** How long "not signed in to the hub here" stands before it is asked again. */
export const ASK_ROLE_AGAIN_MS = 10_000;

const CANCELLED: MacSetupFailure = {
  message: "Cancelled: nothing changed on this Mac.",
  fix: "The code you typed is spent. For a new one, open Add machine › A Mac for agents on your main machine.",
};
const TOKEN_EXPIRED: MacSetupFailure = {
  message: "Your hub took the code, but this Mac didn't join within 15 minutes, so it can't any more.",
  fix: "For a new code, open Add machine › A Mac for agents on your main machine.",
};

/**
 * One setup at a time, as there is one fleetd dir here: the traded code, the join running, and how the last one ended,
 * kept for as long as the app runs so the window, closed and opened again, says what happened.
 */
export class MacSetup {
  #pending: Pending | undefined;
  #join: Promise<MacJoin> | undefined;
  /** The code was spent and nothing joined: cancelled, or a join that failed past the point of trying again. */
  #ended: MacSetupFailure | undefined;
  readonly #ports: MacSetupPorts;
  readonly #report: (join: MacJoin) => void;
  /**
   * Who this app is on each hub, asked once while the hub is behind (health is read every second): an admin or a
   * member is kept; "unknown" only for ASK_ROLE_AGAIN_MS.
   */
  readonly #roles = new Map<string, { readonly role: Promise<HubBehind["who"]>; until: number }>();

  constructor(ports: MacSetupPorts, report: (join: MacJoin) => void) {
    this.#ports = ports;
    this.#report = report;
  }

  async redeem(request: MacRedeemRequest): Promise<MacRedeemOutcome> {
    if (this.#join !== undefined) return { ok: false, failure: { message: "This Mac is joining already." } };
    const { outcome, pending } = await redeemMac(this.#ports, request);
    this.#pending = pending;
    if (pending !== undefined) this.#ended = undefined;
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
      if (join.state === "failed" && join.retry !== true) this.#ended = join.failure ?? { message: "Joining stopped before this Mac joined." };
      return join;
    });
    this.#join = run;
    return run;
  }

  /** The person said no to replacing a node after the hub took the code: the code is spent, and nothing changed. */
  cancel(): void {
    if (this.#join !== undefined || this.#pending === undefined) return;
    this.#pending = undefined;
    this.#ended = CANCELLED;
  }

  /** Where this Mac's setup stands, for a window opening. */
  async status(): Promise<MacSetupStatus> {
    const pending = this.#pending;
    if (this.#join !== undefined && pending !== undefined) return { kind: "joining", found: pending.found };
    const joined = await joinedHere(this.#ports);
    if (joined !== undefined) return { kind: "joined", found: joined };
    if (pending !== undefined) {
      if (Date.parse(pending.expiresAt) > this.#ports.now()) return { kind: "traded", found: pending.found };
      this.#pending = undefined;
      this.#ended = TOKEN_EXPIRED;
    }
    return this.#ended === undefined ? { kind: "fresh" } : { kind: "spent", failure: this.#ended };
  }

  health(hubUrl: string | undefined): Promise<MacHealthRead> {
    return readHealth(this.#ports, hubUrl, (hub) => {
      const now = this.#ports.now();
      let asked = this.#roles.get(hub);
      if (asked === undefined || asked.until <= now) {
        const entry = { role: this.#ports.hubRole(hub).catch(() => "unknown" as const), until: Infinity };
        // Not known yet (a link still coming up, a sign-in here to come): asked again a little later.
        void entry.role.then((role) => {
          if (role === "unknown") entry.until = this.#ports.now() + ASK_ROLE_AGAIN_MS;
        });
        this.#roles.set(hub, entry);
        asked = entry;
      }
      return asked.role;
    });
  }

  /**
   * What the menu bar's popover shows: this Mac's checks, what agents do on it and its disk, once it is joined as the
   * agents' Mac; null before. `hubIdFor` names the hub this app is signed in to at the Mac's hub's address.
   */
  async menuBar(hubIdFor: (hubUrl: string) => string | null): Promise<MacMenuBarRead | null> {
    const found = await joinedHere(this.#ports);
    if (found === undefined) return null;
    const [health, activity, disk] = await Promise.all([
      this.health(found.hubUrl),
      this.#ports.readFile(path.join(this.#ports.fleetdDir, "node", "mac-activity.json")),
      this.#ports.disk(this.#ports.fleetdDir).catch(() => undefined),
    ]);
    return { found, hubId: hubIdFor(found.hubUrl), health, activity: parseActivity(activity?.text), disk: disk ?? null, macBehind: health.macBehind ?? null };
  }

  /** The hub's Update, from this Mac: with the key of an admin this app is signed in as. */
  updateHub(hubUrl: string): Promise<MacHubUpdateOutcome> {
    return this.#ports.updateHub(hubUrl);
  }

  /** A grant: the node asks macOS for it (its prompt, and fleetd in the list), then the CLI opens its pane. Else the link. */
  async openPane(pane: MacPane): Promise<MacRestartOutcome> {
    if (pane === "accessibility" || pane === "screen_recording") return askGrant(this.#ports, pane);
    await this.#ports.openPane(PANE_URLS[pane]);
    return { ok: true };
  }

  restart(): Promise<MacRestartOutcome> {
    return restartNode(this.#ports);
  }
}

/** A hub this app is signed in to: its address, and a call with its key. */
export interface SignedIn {
  readonly url: string;
  call(tool: "hub_info" | "hub_update", input: Record<string, never>): Promise<CallOutcome>;
}

/** hubRole and updateHub with the key of the hub this app is signed in to at the Mac's hub's address, if any. */
export const signedInPorts = (signedIn: () => ReadonlyArray<SignedIn>): Pick<MacSetupPorts, "hubRole" | "updateHub"> => {
  const at = (hubUrl: string): SignedIn | undefined => {
    const origin = hubOrigin(hubUrl);
    return origin === undefined ? undefined : signedIn().find((h) => hubOrigin(h.url) === origin);
  };
  return {
    hubRole: async (hubUrl) => {
      const info = await at(hubUrl)?.call("hub_info", {});
      if (info?.ok !== true) return "unknown";
      // As Settings decides it: an owner or admin whose key isn't capped below.
      return administers(info.output ?? {}) ? "admin" : "member";
    },
    updateHub: async (hubUrl) => {
      const hub = at(hubUrl);
      if (hub === undefined) return { ok: false, failure: { message: "This app isn't signed in to your hub on this Mac.", fix: HUB_UPDATE_WHERE } };
      // fleetd cloud leaves hub_update out (hub_info's leftOut): nothing to ask it.
      const info = await hub.call("hub_info", {});
      if (info.ok && !serves(info.output as { leftOut?: readonly string[] } | undefined, "hub_update")) return { ok: false, failure: { message: "fleetd cloud updates itself." } };
      const out = await hub.call("hub_update", {});
      if (out.ok) return { ok: true };
      const { message, fix } = out.error;
      return { ok: false, failure: { message, ...(fix === undefined ? {} : { fix }) } };
    },
  };
};

/** Where the Tailscale CLI is on a Mac: on PATH, or inside the App Store app. */
const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

export const realMacPorts = (
  join: Pick<JoinPorts, "download" | "run" | "fleetdDir" | "fingerprint" | "baseOverride" | "platform" | "arch">,
  extra: Pick<MacSetupPorts, "knownHubs" | "openPane" | "hubRole" | "updateHub">,
): MacSetupPorts => ({
  ...join,
  disk: async (dir) => {
    const s = await fs.statfs(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  },
  fetch: (url, init) => fetch(url, init),
  knownHubs: extra.knownHubs,
  openPane: extra.openPane,
  hubRole: extra.hubRole,
  updateHub: extra.updateHub,
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
