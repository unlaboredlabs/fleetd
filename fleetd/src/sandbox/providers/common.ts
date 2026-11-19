// The provider interface's shared types and constants (index.ts says what it is), apart so the clients can import them.
import type { Duplex } from "./stream.ts";

export type ProviderId = "boat";
export const PROVIDERS: readonly ProviderId[] = ["boat"];

/** The team's key. */
export type ProviderAuth = { key: string };

/** The label every box fleetd creates carries, and the one `list` keeps. */
export const LABEL = "fleetd";
/** The label holding the idempotency key a box was created with. */
export const KEY_LABEL = "fleetd-key";

/** The port `fleetd sandbox-guest` listens on inside a hosted box (WebSocket, plain: the provider terminates TLS). */
export const GUEST_PORT = 7787;
/** The header carrying fleetd's own per-box secret on that port, besides the provider's access header. */
export const SECRET_HEADER = "x-fleetd-box-secret";

/** A box's size. The design's default is 2 vCPUs and 4 GiB. */
export type Size = { cpu: number; memGb: number };
export const DEFAULT_SIZE: Size = { cpu: 2, memGb: 4 };

/** Where an agent's computer is: this machine's own VM (`vm`), or a box of a hosted provider. */
export type ComputerKind = "vm" | ProviderId;

/**
 * The exact sizes each kind of computer comes in, smallest first: what a bot may pick for its agents, and the only
 * sizes a computer is made at (never rounded to a nearest one). boat's are its machine types (docs.boat.dev/machines).
 * A Local VM's
 * are offered where its machine has the CPUs and twice the memory (the hub's `computerChoices`), and each counts its
 * memory's worth of its machine's slots (hub/slots/board.ts slotsOf).
 */
export const SIZES: Readonly<Record<ComputerKind, readonly Size[]>> = {
  vm: [
    { cpu: 2, memGb: 4 },
    // A VM's own default with no pick (node/place/microvm.ts GUEST_CPUS, GUEST_MEM_GIB): picking it is what Automatic gives.
    { cpu: 4, memGb: 4 },
    { cpu: 4, memGb: 8 },
    { cpu: 8, memGb: 16 },
  ],
  boat: [
    { cpu: 2, memGb: 4 },
    { cpu: 4, memGb: 8 },
    { cpu: 8, memGb: 16 },
    { cpu: 16, memGb: 32 },
  ],
};

export const sameSize = (a: Size, b: Size) => a.cpu === b.cpu && a.memGb === b.memGb;

/** A size as a person reads it: "4 vCPU / 8 GB". */
export const sizeText = (s: Size) => `${s.cpu} vCPU / ${s.memGb} GB`;

/** Why `kind` can't make a computer of `size` exactly, or undefined when it can. */
export function notOffered(kind: ComputerKind, size: Size, name: string = kind === "vm" ? "A Local VM" : kind): string | undefined {
  if (SIZES[kind].some((s) => sameSize(s, size))) return undefined;
  return `${name} comes in no ${sizeText(size)}: its sizes are ${SIZES[kind].map(sizeText).join(", ")}`;
}

export type Box = { id: string; labels: Record<string, string> };

export type CreateOptions = {
  /** The template (a saved snapshot, on boat) the box starts from, as `build` named it. */
  template: string;
  /** Lowercase letters, digits and hyphens, 1 to 63: the same key makes no second box. */
  key: string;
  /** Labels to find it by (the session's, the machine's); `fleetd` and `fleetd-key` are added. No secrets. */
  labels: Record<string, string>;
  /** How long the box may live from now unless extended: the provider deletes it then. */
  lifetimeMs: number;
  /** The box's size: boat sizes a box at create. */
  size?: Size;
  /** A bot's image build's box (`snapshot`): made so the provider can save it. */
  keep?: boolean;
  signal?: AbortSignal;
};

export type StartOptions = {
  argv: string[];
  /** This command's environment only: where secrets go. */
  env: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
};

export type BuildOptions = { name: string; size?: Size; signal?: AbortSignal; onLog?: (line: string) => void };

/** What fleetd does with a provider: nothing more. */
export interface Provider {
  readonly id: ProviderId;
  /** Creates a box from `template`; the same `key` again answers the same box. */
  create(o: CreateOptions): Promise<Box>;
  /** Deletes the box and its data; a box already gone is no error. */
  destroy(id: string, o?: { signal?: AbortSignal }): Promise<void>;
  /** fleetd's own boxes in the account (label `fleetd`), whatever their state: for the leak sweep and Settings' Test. */
  list(o?: { signal?: AbortSignal }): Promise<Box[]>;
  /** Starts a detached command, with no time limit and no stdin; resolves once it runs. */
  start(id: string, o: StartOptions): Promise<void>;
  /** A byte stream to `port` inside the box: WSS with the provider's access header plus `secret` in SECRET_HEADER. */
  connect(id: string, port: number, secret: string, o?: { signal?: AbortSignal }): Promise<Duplex>;
  /** A file of the box, refused when it is longer than `max` bytes. */
  read(id: string, path: string, max: number, o?: { signal?: AbortSignal }): Promise<Uint8Array>;
  /** Sets the box's remaining life to `ms` from now: calling it again extends it. */
  lifetime(id: string, ms: number, o?: { signal?: AbortSignal }): Promise<void>;
  /** Builds `dockerfile` (one FROM, then RUN/ENV/WORKDIR/USER only) into the team's account as `o.name`; answers what `create` takes. */
  build(dockerfile: string, o: BuildOptions): Promise<string>;
  /** Saves the box's disk as `name`, what `create` then takes as its template (a bot's computer image); a provider
   * without it gives its bots no image, and their boxes start from the template and run setup. */
  snapshot?(id: string, name: string, o?: { signal?: AbortSignal }): Promise<string>;
  /** Deletes what `snapshot` made; one already gone is no error. */
  forget?(template: string, o?: { signal?: AbortSignal }): Promise<void>;
}

/** The stand-in servers' hooks: another fetch and WebSocket, other base URLs, and how often a build is polled. */
export type ClientOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Overrides the provider's base URLs, for stand-in servers. */
  urls?: { api?: string; sandbox?: (id: string, port: number) => string };
  WebSocket?: typeof WebSocket;
  pollMs?: number;
};

/** Why `key` can't be an idempotency key, or undefined. Every provider takes this form. */
export function badKey(key: string): string | undefined {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(key) ? undefined : `an idempotency key is 1 to 63 lowercase letters, digits or hyphens, not ${JSON.stringify(key)}`;
}

/** The labels a box is created with: the caller's, plus fleetd's own. */
export const labelsFor = (o: CreateOptions): Record<string, string> => ({ ...o.labels, [LABEL]: "1", [KEY_LABEL]: o.key });
