// Pairing with a hub: the pure rules shared by main (which talks to the hub) and the renderer (which shows it).
// The contract is `POST <hub>/pair {code, deviceName}` → `{key, hubUrl, hubName}` or the hub's `{code, message, fix}`.

/** The /app protocol this app speaks (fleetd_contracts::hello::PROTOCOL_VERSION). */
export const APP_PROTOCOL = 1;

/** Where `fleetd init` puts the hub unless told otherwise. */
export const LOCAL_HUB = "http://127.0.0.1:4790";

/** What went wrong and how to fix it, worded by the hub when it answered and by the app when it didn't. */
export interface PairFailure {
  /** The hub's code (`pair_code_invalid`, `pair_code_expired`, `pair_rate_limited`) or "" for the app's own. */
  readonly code: string;
  readonly message: string;
  readonly fix?: string;
}

export type PairOutcome =
  | { readonly ok: true; readonly hubName: string }
  | { readonly ok: false; readonly failure: PairFailure };

/** A hub's `/healthz`, as found. */
export type Probe =
  | { readonly answers: true; readonly hub: string; readonly version: string; readonly protocol: number }
  | { readonly answers: false; readonly hub: string };

/** The `app-pair.json` that `fleetd init` / `fleetd pair` leave on the hub machine, as main reads it. */
export interface AppPair {
  readonly hub: string;
  readonly code: string;
  readonly expired: boolean;
}

/**
 * What the connect screen starts from. The file's code stays in main: the screen learns only which hub it names
 * and whether it is still fresh, and asks main to pair from it (`pair:auto`).
 */
export interface PairStart {
  readonly appPair: { readonly hub: string; readonly expired: boolean } | null;
  /** app-pair.json was there but not trusted (wrong owner or mode, a symlink, a public hub…), and why. */
  readonly problem: PairFailure | null;
  readonly probe: Probe;
}

/**
 * "Set up fleetd on this Mac": `fleetd init` opened in the system terminal (`terminal` says which, for the line
 * after), or why it couldn't be, with the command to run instead.
 */
export type SetupOutcome =
  | { readonly ok: true; readonly terminal: string }
  | { readonly ok: false; readonly message: string; readonly command: string };

/** Where this app keeps its hub key, so the screens never claim more than is true. */
export type KeyStore =
  | { readonly kind: "os"; readonly where: string }
  /** A 0600 file: `why` the OS store isn't used, and `fix`, how to get the key into it. */
  | { readonly kind: "file"; readonly path: string; readonly why: string; readonly fix: string }
  /** FLEETD_HUB_URL and FLEETD_AGENT_KEY: used for this run, saved nowhere. */
  | { readonly kind: "env" };

/** One line for the connect form and Settings. */
export const keyStoreLine = (store: KeyStore): string =>
  store.kind === "os"
    ? `The key is kept encrypted in ${store.where}.`
    : store.kind === "env"
      ? "The key comes from FLEETD_AGENT_KEY for this run and is saved nowhere."
      : `The key is kept in a file only you can read (${store.path}), not encrypted. ${store.why} ${store.fix}`;

/** What the renderer sends to redeem a code; shared/ipc.ts validates it in main. */
export interface PairRequest {
  readonly hub: string;
  readonly code: string;
}

/** Crockford base32 without I L O U, as `fleetd pair` mints them. */
const CODE_CHARS = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

/**
 * A code as typed → `XXXX-XXXX`, or null if it can't be one. Any case, spaces and hyphens anywhere, and the
 * look-alikes Crockford reads as digits (I and L as 1, O as 0), as the hub's own `pair::normalize` accepts.
 */
export const normalizeCode = (input: string): string | null => {
  const raw = input
    .replace(/[\s-]/gu, "")
    .toUpperCase()
    .replace(/[IL]/gu, "1")
    .replace(/O/gu, "0");
  return CODE_CHARS.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
};

/**
 * The hub's HTTP origin from what someone typed: `hub:4790`, `http://…`, or the `ws(s)://…/app` URL a key was
 * saved with. Paths are dropped: /pair and /healthz sit at the root.
 */
export const hubOrigin = (input: string): { ok: true; origin: string } | { ok: false; failure: PairFailure } => {
  const fail = (message: string) =>
    ({ ok: false, failure: { code: "", message, fix: `Use the hub's address, e.g. ${LOCAL_HUB}.` } }) as const;
  const trimmed = input.trim();
  if (trimmed === "") return fail("Enter your hub's address.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(trimmed)?.[1]?.toLowerCase();
  const web = scheme === undefined ? "http" : { http: "http", ws: "http", https: "https", wss: "https" }[scheme];
  if (web === undefined) return fail("Use an http:// or https:// address.");
  let url: URL;
  try {
    url = new URL(scheme === undefined ? `http://${trimmed}` : `${web}${trimmed.slice(scheme.length)}`);
  } catch {
    return fail(`"${trimmed}" isn't an address.`);
  }
  if (url.hostname === "") return fail("The address needs a host.");
  return { ok: true, origin: url.origin };
};

/** Reads app-pair.json's text; null unless it names a hub and a code. `nowMs` decides `expired`. */
export const readAppPair = (text: string, nowMs: number): AppPair | null => {
  const json = safeJson(text);
  if (typeof json !== "object" || json === null) return null;
  const { hub, code, expiresAt } = json as Record<string, unknown>;
  if (typeof hub !== "string" || hub === "" || typeof code !== "string" || code === "" || typeof expiresAt !== "string") return null;
  const at = Date.parse(expiresAt);
  return { hub, code, expired: Number.isNaN(at) || at <= nowMs };
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export type ProtocolFit = "ok" | "hub-older" | "app-older";

/** A hub on another protocol can't serve this app: one of them needs an update. */
export const protocolFit = (hubProtocol: number): ProtocolFit =>
  hubProtocol === APP_PROTOCOL ? "ok" : hubProtocol < APP_PROTOCOL ? "hub-older" : "app-older";

/**
 * Orders versions as semver does: dotted numbers (`0.10.0` after `0.9.3`), a pre-release before its release, and
 * pre-releases by their dot-separated parts, numbers numerically, so a later nightly (`-nightly.202610221030`) is
 * newer. Build metadata (`+abc1234`) doesn't count. Null when either isn't a version, so nothing is flagged on a guess.
 */
export const compareVersions = (a: string, b: string): number | null => {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]*)?$/u.exec(v.trim());
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  for (const i of [1, 2, 3]) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  const [px, py] = [x[4], y[4]];
  if (px === py) return 0;
  if (px === undefined) return 1;
  if (py === undefined) return -1;
  const xs = px.split(".");
  const ys = py.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const [p, q] = [xs[i], ys[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [np, nq] = [/^\d+$/u.test(p), /^\d+$/u.test(q)];
    const d = np && nq ? Math.sign(Number(p) - Number(q)) : np ? -1 : nq ? 1 : p < q ? -1 : p > q ? 1 : 0;
    if (d !== 0) return d;
  }
  return 0;
};

/** Machines whose node runs an older fleetd than the hub, by name. A node reporting 0.0.0 hasn't said its version. */
export const olderNodes = (
  machines: ReadonlyArray<{ readonly name: string; readonly nodeVersion: string }>,
  hubVersion: string,
): ReadonlyArray<string> =>
  machines.filter((m) => compareVersions(m.nodeVersion, "0.0.0") !== 0 && compareVersions(m.nodeVersion, hubVersion) === -1).map((m) => m.name);
