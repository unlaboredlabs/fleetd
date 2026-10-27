import { hostname } from "node:os";
import { join } from "node:path";
import type { ConnectOutcome } from "../../shared/hub";
import type { PairTarget } from "../../shared/hubs";
import {
  hubOrigin,
  LOCAL_HUB,
  normalizeCode,
  readAppPair,
  type AppPair,
  type KeyStore,
  type PairFailure,
  type PairOutcome,
  type PairRequest,
  type PairStart,
  type Probe,
  type SetupOutcome,
} from "../../shared/pairing";
import { privateHubOrigin, readAppPairFile, removeAppPairFile, type FileRead } from "./appPairFile";
import { probe, redeem, type Fetch } from "./hubHttp";
import { trustSystemCAs } from "../trust";
import { openSetup, realTerminalDeps } from "./terminal";

/** The startup probe only decides a hint, so it gives up quickly. */
const PROBE_TIMEOUT_MS = 2_000;

export interface PairingDeps {
  readonly fetch: Fetch;
  /** The hubs' connect: validates, saves the key with safeStorage into the hub `target` names, connects. */
  readonly connect: (url: string, key: string, target?: PairTarget) => ConnectOutcome;
  /** app-pair.json pairs by itself only on first run: no key saved, none refused. */
  readonly firstRun: () => boolean;
  readonly appPairFile: string;
  readonly readFile: (path: string) => Promise<FileRead>;
  readonly remove: (path: string) => Promise<void>;
  readonly now: () => number;
  readonly deviceName: () => string;
  /** Where the hub service keeps the key it is given. */
  readonly keyStore: KeyStore;
  /** `fleetd init` in the system terminal (terminal.ts). */
  readonly openSetup: () => Promise<SetupOutcome>;
}

/** Names the new key on the hub: this computer's name. */
const deviceName = (): string => hostname().trim().replace(/\.local$/u, "") || "desktop app";

/**
 * `fleetdDir` is the fleetd dir main already resolved (FLEETD_HOME, else <appData>/fleetd), where `fleetd init` /
 * `fleetd pair` write app-pair.json (crates/fleetd/src/cli/pair.rs `app_pair_file`).
 */
export const realPairingDeps = (
  fleetdDir: string,
  connect: PairingDeps["connect"],
  firstRun: () => boolean,
  keyStore: KeyStore,
): PairingDeps => ({
  keyStore,
  // Node's fetch, not Electron's `net`: the page's session (defaultSession) blocks every request but its own origin.
  fetch: (url, init) => {
    trustSystemCAs();
    return globalThis.fetch(url, init);
  },
  connect,
  firstRun,
  appPairFile: join(fleetdDir, "app-pair.json"),
  readFile: readAppPairFile,
  remove: removeAppPairFile,
  now: Date.now,
  deviceName,
  openSetup: () => openSetup(realTerminalDeps()),
});

type Loaded = { kind: "none" } | { kind: "untrusted"; failure: PairFailure } | { kind: "found"; pair: AppPair & { origin: string } };

export class PairingService {
  readonly #deps: PairingDeps;

  constructor(deps: PairingDeps) {
    this.#deps = deps;
  }

  /** What the connect screen opens with: which hub app-pair.json names (never its code), and whether a hub answers. */
  async start(): Promise<PairStart> {
    const loaded = await this.#load();
    if (loaded.kind === "found" && loaded.pair.expired) await this.#spend();
    const appPair = loaded.kind === "found" ? { hub: loaded.pair.origin, expired: loaded.pair.expired } : null;
    return {
      appPair,
      problem: loaded.kind === "untrusted" ? loaded.failure : null,
      probe: await this.probe(appPair?.hub ?? LOCAL_HUB),
    };
  }

  store(): KeyStore {
    return this.#deps.keyStore;
  }

  /** Opens `fleetd init` in a terminal; once it has paired this app's code, the connect screen picks it up. */
  setup(): Promise<SetupOutcome> {
    return this.#deps.openSetup();
  }

  async probe(hub: string): Promise<Probe> {
    const origin = hubOrigin(hub);
    return origin.ok ? probe(this.#deps.fetch, origin.origin, PROBE_TIMEOUT_MS) : { answers: false, hub };
  }

  /** A typed code: trades it for a key, then saves it and connects through the hub service. */
  async redeem(request: PairRequest): Promise<PairOutcome> {
    const origin = hubOrigin(request.hub);
    if (!origin.ok) return origin;
    return this.#pair(origin.origin, request.code, false, request.target);
  }

  /** Pairs from app-pair.json, read again here: the page only asks, it never supplies the code or the hub. */
  async auto(): Promise<PairOutcome> {
    const fail = (message: string): PairOutcome => ({
      ok: false,
      failure: { code: "", message, fix: "Run `fleetd pair` on the hub and type the code it prints." },
    });
    if (!this.#deps.firstRun()) return fail("This app already has a hub key, so it won't pair from app-pair.json.");
    const loaded = await this.#load();
    if (loaded.kind === "untrusted") return { ok: false, failure: loaded.failure };
    if (loaded.kind === "none") return fail("No pairing code from `fleetd init` on this computer.");
    if (loaded.pair.expired) {
      await this.#spend();
      return fail("The code `fleetd init` left on this computer has expired.");
    }
    return this.#pair(loaded.pair.origin, loaded.pair.code, true);
  }

  async #pair(origin: string, typed: string, fromFile: boolean, target?: PairTarget): Promise<PairOutcome> {
    const code = normalizeCode(typed);
    if (code === null) {
      return {
        ok: false,
        failure: {
          code: "",
          message: "A pairing code is 8 letters and digits, like ABCD-2345.",
          fix: "Run `fleetd pair` on the hub and type the code it prints.",
        },
      };
    }
    const result = await redeem(this.#deps.fetch, origin, code, this.#deps.deviceName());
    // The hub has used up or refused the code: the file is spent either way.
    if (fromFile && (result.ok || result.failure.code.startsWith("pair_code_"))) await this.#spend();
    if (!result.ok) return result;
    const connected = this.#deps.connect(origin, result.paired.key, target);
    return connected.ok
      ? { ok: true, hubName: result.paired.hubName }
      : {
          ok: false,
          failure: {
            code: "",
            message: `Paired with ${result.paired.hubName}, but the key couldn't be kept: ${connected.message}`,
            fix: "Run `fleetd pair` on the hub for a new code and try again.",
          },
        };
  }

  async #load(): Promise<Loaded> {
    const path = this.#deps.appPairFile;
    const read = await this.#deps.readFile(path);
    if (!read.ok) return read.missing ? { kind: "none" } : { kind: "untrusted", failure: read.failure };
    const untrusted = (why: string): Loaded => ({
      kind: "untrusted",
      failure: { code: "", message: `Ignored ${path}: ${why}`, fix: "Type your hub's address and a code from `fleetd pair` below." },
    });
    const pair = readAppPair(read.text, this.#deps.now());
    if (pair === null) return untrusted("it isn't a pairing file.");
    const origin = hubOrigin(pair.hub);
    if (!origin.ok || !privateHubOrigin(origin.origin)) {
      return untrusted(`its hub (${pair.hub}) isn't on this computer, a private network or a tailnet.`);
    }
    return { kind: "found", pair: { ...pair, origin: origin.origin } };
  }

  async #spend(): Promise<void> {
    await this.#deps.remove(this.#deps.appPairFile).catch(() => undefined);
  }
}
