import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ConnectOutcome } from "../../shared/hub";
import {
  hubOrigin,
  LOCAL_HUB,
  normalizeCode,
  readAppPair,
  type PairOutcome,
  type PairRequest,
  type PairStart,
  type Probe,
} from "../../shared/pairing";
import { probe, redeem, type Fetch } from "./hubHttp";

/** The startup probe only decides a hint, so it gives up quickly. */
const PROBE_TIMEOUT_MS = 2_000;

export interface PairingDeps {
  readonly fetch: Fetch;
  /** The hub service's connect: validates, saves the key with safeStorage, connects. */
  readonly connect: (url: string, key: string) => ConnectOutcome;
  readonly appPairFile: string;
  readonly readText: (path: string) => Promise<string | null>;
  readonly remove: (path: string) => Promise<void>;
  readonly now: () => number;
  readonly deviceName: () => string;
}

/** Names the new key on the hub: this computer's name. */
const deviceName = (): string => hostname().trim().replace(/\.local$/u, "") || "desktop app";

/**
 * `fleetdDir` is the fleetd dir main already resolved (FLEETD_HOME, else <appData>/fleetd), where `fleetd init` /
 * `fleetd pair` write app-pair.json (crates/fleetd/src/cli/pair.rs `app_pair_file`).
 */
export const realPairingDeps = (fleetdDir: string, connect: PairingDeps["connect"]): PairingDeps => ({
  fetch: (url, init) => globalThis.fetch(url, init),
  connect,
  appPairFile: join(fleetdDir, "app-pair.json"),
  readText: (path) => readFile(path, "utf8").catch(() => null),
  remove: (path) => rm(path, { force: true }),
  now: Date.now,
  deviceName,
});

export class PairingService {
  readonly #deps: PairingDeps;

  constructor(deps: PairingDeps) {
    this.#deps = deps;
  }

  /** What the connect screen opens with: a code `fleetd init` left here, and whether a hub answers. */
  async start(): Promise<PairStart> {
    const text = await this.#deps.readText(this.#deps.appPairFile);
    const appPair = text === null ? null : readAppPair(text, this.#deps.now());
    return { appPair, probe: await this.probe(appPair?.hub ?? LOCAL_HUB) };
  }

  async probe(hub: string): Promise<Probe> {
    const origin = hubOrigin(hub);
    return origin.ok ? probe(this.#deps.fetch, origin.origin, PROBE_TIMEOUT_MS) : { answers: false, hub };
  }

  /** Trades the code for a key, then saves it and connects through the hub service. */
  async redeem(request: PairRequest): Promise<PairOutcome> {
    const origin = hubOrigin(request.hub);
    if (!origin.ok) return origin;
    const code = normalizeCode(request.code);
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
    const result = await redeem(this.#deps.fetch, origin.origin, code, this.#deps.deviceName());
    // The hub has used up or refused the code: the file is spent either way.
    if (request.fromFile && (result.ok || result.failure.code.startsWith("pair_code_"))) {
      await this.#deps.remove(this.#deps.appPairFile).catch(() => undefined);
    }
    if (!result.ok) return result;
    const connected = this.#deps.connect(origin.origin, result.paired.key);
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
}
