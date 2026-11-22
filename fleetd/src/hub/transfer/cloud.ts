// fleetd cloud's owner routes for a hub moving in (fleetd-cloud src/transfer/http.ts), as the moving hub calls them
// with a device key of an owner of the team:
//
//   POST   /transfer/v1/imports                 a new import into the empty team: { runId, pieceBytes, maxBytes?, migrations? }
//   PUT    /transfer/v1/imports/{run}/{n}       the export's n-th piece; sent again after a cut, it replaces itself
//   POST   /transfer/v1/imports/{run}/start     its passphrase in a header, never in an address
//   DELETE /transfer/v1/imports/{run}           an upload given up: the run ends, its pieces go
//   GET    /transfer/v1/runs/{run}              the run: state, and its summary or what stopped it
//   POST   /transfer/v1/imports/{run}/rejoin    a done run's machines, each with a fresh one-time code to enrol by
//   GET    /transfer/v1/imports/{run}/rejoin    the same, codes left out: which machines have joined
//
// A refusal is the hub's `{ code, message, fix }` with a `reason` to key on. Nothing here logs a key, a code or the
// passphrase.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The cloud answered with a refusal. */
export class CloudRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string | undefined,
    message: string,
    readonly fix: string | undefined,
  ) {
    super(message);
  }
}

/** The cloud wasn't reached, or answered with something that isn't fleetd cloud's: worth trying again. */
export class CloudUnreached extends Error {}

export type Begun = { runId: string; pieceBytes: number; maxBytes?: number; migrations?: string[] };
export type RunState = "uploading" | "queued" | "running" | "done" | "failed";
export type RunAnswer = { state: RunState; summary?: Record<string, unknown>; error?: { code: string; message: string; fix?: string; reason?: string } };
export type RejoinMachine = { machineId: string; name: string; code?: string; joined: boolean };
export type Rejoin = { hubUrl?: string; machines: RejoinMachine[] };

const PASSPHRASE_HEADER = "fleetd-export-passphrase";
const CALL_MS = 30_000;
/** A piece is up to 16 MiB: on a slow link it takes a while. */
const PIECE_MS = 5 * 60_000;

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export class CloudTransfer {
  constructor(
    private readonly origin: string,
    private readonly key: string,
    private readonly fetch: Fetch,
  ) {}

  private async call(method: string, path: string, opts: { body?: Uint8Array; headers?: Record<string, string>; ms?: number } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(`${this.origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.key}`, ...(opts.body ? { "content-type": "application/octet-stream" } : {}), ...opts.headers },
        ...(opts.body ? { body: opts.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(opts.ms ?? CALL_MS),
      });
    } catch (error) {
      throw new CloudUnreached((error as Error).message);
    }
    if (response.status === 204) return undefined;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (response.ok) return json;
    const body = record(json);
    const message = str(body.message);
    // A gateway's page, not the service's answer: the cloud is restarting or not reached.
    if (message === undefined && (response.status >= 500 || response.status === 429)) throw new CloudUnreached(`HTTP ${response.status}`);
    throw new CloudRefusal(response.status, str(body.code) ?? "", str(body.reason), message ?? `fleetd cloud answered HTTP ${response.status}.`, str(body.fix));
  }

  async begin(): Promise<Begun> {
    const b = record(await this.call("POST", "/transfer/v1/imports"));
    const runId = str(b.runId);
    const pieceBytes = b.pieceBytes;
    if (runId === undefined || typeof pieceBytes !== "number" || pieceBytes < 1) throw new CloudUnreached("fleetd cloud answered the import's start in a way this hub doesn't understand");
    const migrations = Array.isArray(b.migrations) && b.migrations.every((m) => typeof m === "string") ? (b.migrations as string[]) : undefined;
    return { runId, pieceBytes, ...(typeof b.maxBytes === "number" ? { maxBytes: b.maxBytes } : {}), ...(migrations ? { migrations } : {}) };
  }

  async put(runId: string, n: number, bytes: Uint8Array): Promise<void> {
    await this.call("PUT", `/transfer/v1/imports/${runId}/${n}`, { body: bytes, ms: PIECE_MS });
  }

  async start(runId: string, passphrase: string): Promise<void> {
    await this.call("POST", `/transfer/v1/imports/${runId}/start`, { headers: { [PASSPHRASE_HEADER]: passphrase } });
  }

  async drop(runId: string): Promise<void> {
    await this.call("DELETE", `/transfer/v1/imports/${runId}`);
  }

  async run(runId: string): Promise<RunAnswer> {
    const b = record(await this.call("GET", `/transfer/v1/runs/${runId}`));
    const state = str(b.state) as RunState | undefined;
    if (state === undefined) throw new CloudUnreached("fleetd cloud answered the import's state in a way this hub doesn't understand");
    const e = record(b.error);
    const error = str(e.message) === undefined ? undefined : { code: str(e.code) ?? "", message: str(e.message)!, ...(str(e.fix) ? { fix: str(e.fix)! } : {}), ...(str(e.reason) ? { reason: str(e.reason)! } : {}) };
    return { state, ...(b.summary !== undefined ? { summary: record(b.summary) } : {}), ...(error ? { error } : {}) };
  }

  private rejoinOf(json: unknown): Rejoin {
    const b = record(json);
    const machines = (Array.isArray(b.machines) ? b.machines : []).flatMap((raw): RejoinMachine[] => {
      const m = record(raw);
      const machineId = str(m.machineId);
      if (machineId === undefined) return [];
      return [{ machineId, name: str(m.name) ?? machineId, joined: m.joined === true, ...(str(m.code) ? { code: str(m.code)! } : {}) }];
    });
    return { ...(str(b.hubUrl) ? { hubUrl: str(b.hubUrl)! } : {}), machines };
  }

  /** Fresh codes for every machine not joined yet; each voids that machine's open one. */
  async codes(runId: string): Promise<Rejoin> {
    return this.rejoinOf(await this.call("POST", `/transfer/v1/imports/${runId}/rejoin`));
  }

  async joined(runId: string): Promise<Rejoin> {
    return this.rejoinOf(await this.call("GET", `/transfer/v1/imports/${runId}/rejoin`));
  }
}
