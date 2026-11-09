// The boat.dev REST client: the few calls the pool makes, straight to
// `https://boat.dev/api/v1`, with a typed error for each code boat documents. A create carries an Idempotency-Key and
// is sent as the exact bytes the ledger sealed, so a retry is byte-identical. Every ttl goes out as a `Ttl`, which
// only the lease's one clamping function makes: no call here can send `null`, boat's "never stop".
import { parseMs, isoMs } from "../store/time.ts";
import type { Ttl } from "./lease.ts";

export const API = "https://boat.dev/api/v1";
const TIMEOUT_MS = 30_000;
const PAGE = 200;
const MAX_PAGES = 100;

/** A sandbox as boat answers it, with the fields the pool reads. */
export type Sandbox = {
  id: string;
  state: string;
  labels: Record<string, string>;
  archiveAfter?: string | null;
  ttlSeconds?: number | null;
  setupStatus?: string | null;
  setupError?: string | null;
  dataExpiredAt?: string | null;
  error?: string | null;
  hydrated?: boolean | null;
  sshEndpoint?: string | null;
  /** A resume found it running already: no start was counted. Not boat's field. */
  alreadyRunning?: boolean;
};

export type Phase = "up" | "stopping" | "stopped" | "dead";

export function phase(sb: Sandbox): Phase {
  if (sb.state === "archiving") return "stopping";
  if (sb.state === "archived") return "stopped";
  if (sb.state === "error" || sb.state === "cancelled") return "dead";
  return "up";
}

export const archiveAfterMs = (sb: Sandbox) => (sb.archiveAfter ? parseMs(sb.archiveAfter) : undefined);

export type StartLimits = { perMinute: number; perHour: number; perDay: number };
export type MachineType = { type: string; available: boolean; reason?: string | null };
export type Limits = {
  canStart: boolean;
  startBlockedReason?: string | null;
  nextStartDollars?: number | null;
  activeSandboxes: number;
  maxActiveSandboxes: number;
  startLimits?: StartLimits | null;
  sandboxPlanDollars?: number | null;
  machineTypes: MachineType[];
};

export type SshAccess = { machineIp?: string | null; sshEndpoint?: string | null; sshUser?: string | null; hostKey?: string | null };

/** Where to dial: the IPv4 `sshEndpoint`, `seen`'s first, else this answer's. Never the machine's own IPv6 address. */
export function sshTarget(access: SshAccess, seen?: Sandbox): [string, number] | undefined {
  const endpoint = [seen?.sshEndpoint, access.sshEndpoint].find((e) => typeof e === "string" && e !== "");
  if (!endpoint) return undefined;
  const at = endpoint.lastIndexOf(":");
  if (at < 0) return undefined;
  const port = Number(endpoint.slice(at + 1));
  if (!/^[0-9]+$/.test(endpoint.slice(at + 1)) || port > 65535) return undefined;
  return [endpoint.slice(0, at).replace(/^\[|\]$/g, ""), port];
}

export const sshUser = (a: SshAccess) => (a.sshUser ? a.sshUser : "user");

export type File = { path: string; content: string };

/** `POST /sandboxes`, as the pool always sends it: noEnv, monitoring off, failFast. */
export type CreateBody = {
  type: string;
  name: string;
  labels: Record<string, string>;
  ttlSeconds: Ttl;
  noEnv: true;
  monitoring: false;
  failFast: true;
  environment?: string;
  setupScript?: string;
  files?: File[];
};

export const createBody = (kind: string, name: string, labels: Record<string, string>, ttl: Ttl): CreateBody => ({
  type: kind,
  name,
  labels,
  ttlSeconds: ttl,
  noEnv: true,
  monitoring: false,
  failFast: true,
});

/** The body's bytes as serde writes the Rust struct: its fields in order, labels sorted, empty extras left out. */
export function createBytes(b: CreateBody): Uint8Array {
  const labels = Object.fromEntries(Object.keys(b.labels).sort().map((k) => [k, b.labels[k]]));
  return new TextEncoder().encode(
    JSON.stringify({
      type: b.type,
      name: b.name,
      labels,
      ttlSeconds: b.ttlSeconds.seconds,
      noEnv: b.noEnv,
      monitoring: b.monitoring,
      failFast: b.failFast,
      ...(b.environment !== undefined ? { environment: b.environment } : {}),
      ...(b.setupScript !== undefined ? { setupScript: b.setupScript } : {}),
      ...(b.files && b.files.length > 0 ? { files: b.files } : {}),
    }),
  );
}

/** What boat refused, one case per code it documents. */
export type BoatError =
  | { kind: "rate_limited"; nextStartAt?: number; retryAfterS?: number }
  | { kind: "limit_reached" }
  | { kind: "member_limit_reached" }
  | { kind: "billing"; code: string; url?: string }
  | { kind: "no_ready_machine" }
  | { kind: "out_of_capacity"; retryAfterS?: number }
  | { kind: "ip_rate_limited"; retryAfterS?: number }
  | { kind: "key_refused"; code: string }
  | { kind: "not_found" }
  | { kind: "data_expired" }
  | { kind: "idempotency_in_progress" }
  | { kind: "idempotency_key_reused" }
  | { kind: "conflict"; code: string }
  | { kind: "unknown_environment"; name: string }
  | { kind: "refused"; status: number; code: string }
  | { kind: "server"; status: number }
  | { kind: "network"; message: string }
  | { kind: "no_key"; message: string };

/** A thrown BoatError. */
export class BoatFailure extends Error {
  constructor(readonly error: BoatError) {
    super(boatLine(error));
    this.name = "BoatFailure";
  }
}

export const boatError = (e: unknown): BoatError =>
  e instanceof BoatFailure ? e.error : { kind: "network", message: e instanceof Error ? e.message : String(e) };

/** One plain line for the person. */
export function boatLine(e: BoatError): string {
  switch (e.kind) {
    case "rate_limited":
      return "boat.dev start limit reached";
    case "limit_reached":
      return "boat.dev: machines-at-once limit reached";
    case "member_limit_reached":
      return "boat.dev: your organization's machines-at-once cap is reached";
    case "billing":
      return `boat.dev needs billing attention (${e.code}): Settings › Hub › Machines`;
    case "no_ready_machine":
    case "out_of_capacity":
      return "boat.dev is short of machines, retrying";
    case "ip_rate_limited":
      return "boat.dev rate limit, retrying";
    case "key_refused":
      return `boat.dev key refused (${e.code}): Settings › Hub › Machines`;
    case "not_found":
      return "boat.dev has no such machine";
    case "data_expired":
      return "boat.dev deleted the stopped machine's disk";
    case "idempotency_in_progress":
      return "boat.dev is still making this machine";
    case "idempotency_key_reused":
      return "boat.dev refused a changed retry";
    case "conflict":
      return `boat.dev refused it (${e.code})`;
    case "unknown_environment":
      return (
        `boat.dev has no environment named ${e.name} on the account the hub's key is from (unknown_environment): ` +
        "make it in boat.dev › Environments on your own account, not an organization's, with Safe for third parties " +
        "on, or save the name of the one the key is scoped to in Settings › Hub › Machines › Cloud machines; then Create again"
      );
    case "refused":
      return `boat.dev refused it (${e.status} ${e.code})`;
    case "server":
    case "network":
      return "boat.dev unreachable, retrying";
    case "no_key":
      return e.message;
  }
}

/** A refusal of what this one request asked, which says nothing about starts in general. */
export const aboutTheRequest = (e: BoatError) =>
  e.kind === "unknown_environment" || e.kind === "refused" || e.kind === "conflict" || e.kind === "idempotency_key_reused";

/** A refusal's typed error, from its status, its body's `code` and the fields beside it, and Retry-After. */
export function refusal(status: number, body: unknown, retryAfter?: number): BoatError {
  const b = (body ?? {}) as Record<string, unknown>;
  const err = (b.error ?? {}) as Record<string, unknown>;
  const details = (err.details ?? {}) as Record<string, unknown>;
  const code = typeof b.code === "string" ? b.code : typeof err.code === "string" ? err.code : "";
  const field = (name: string) => (b[name] !== undefined && b[name] !== null ? b[name] : details[name] !== null ? details[name] : undefined);
  const secs = (name: string) => {
    const v = field(name);
    return typeof v === "number" ? Math.ceil(Math.max(0, v)) : undefined;
  };
  const retry = retryAfter ?? secs("retryAfterSeconds") ?? secs("retryAfter");
  const r = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
  if (status === 429 && code === "rate_limited") {
    const at = field("nextStartAt");
    return r({ kind: "rate_limited", nextStartAt: typeof at === "string" ? parseMs(at) : undefined, retryAfterS: retry });
  }
  if (status === 429 && code === "limit_reached") return { kind: "limit_reached" };
  if (status === 429 && code === "member_limit_reached") return { kind: "member_limit_reached" };
  if (status === 402 || (status === 429 && code === "trial_compute_limit_reached")) {
    const url = field("billingUrl");
    return r({ kind: "billing", code: code === "" ? "billing_required" : code, url: typeof url === "string" ? url : undefined });
  }
  if (status === 429 && code.toLowerCase() === "ip_rate_limit_exceeded") return r({ kind: "ip_rate_limited", retryAfterS: retry });
  if (status === 503 && code === "no_ready_machine") return { kind: "no_ready_machine" };
  if (status === 503 && code === "out_of_capacity") return r({ kind: "out_of_capacity", retryAfterS: retry });
  if (status === 401) return { kind: "key_refused", code: code === "" ? "unauthorized" : code };
  if (status === 403 && (code.startsWith("api_key_") || code === "forbidden" || code === "unauthorized")) return { kind: "key_refused", code };
  if (status === 400 && code === "unknown_environment") return { kind: "unknown_environment", name: "" };
  if (status === 404) return { kind: "not_found" };
  if (status === 409 && code === "snapshot_data_expired") return { kind: "data_expired" };
  if (status === 409 && code === "idempotency_in_progress") return { kind: "idempotency_in_progress" };
  if (status === 409 && code === "idempotency_key_reused") return { kind: "idempotency_key_reused" };
  if (status === 409) return { kind: "conflict", code };
  if (status >= 500) return { kind: "server", status };
  return { kind: "refused", status, code };
}

/** The calls the pool makes; tests use a fake. Every failure is a thrown BoatFailure. */
export interface Boat {
  create(idemKey: string, body: Uint8Array): Promise<Sandbox>;
  get(id: string): Promise<Sandbox>;
  /** Every sandbox carrying all of `labels`, in every state, every page read. */
  list(labels: [string, string][]): Promise<Sandbox[]>;
  setTtl(id: string, ttl: Ttl): Promise<void>;
  stop(id: string): Promise<void>;
  resume(id: string, ttl: Ttl): Promise<Sandbox>;
  delete(id: string): Promise<void>;
  limits(): Promise<Limits>;
  sshKey(id: string, publicKey: string): Promise<SshAccess>;
  usage(id: string, sinceMs: number): Promise<number>;
}

const sandboxOf = (v: unknown): Sandbox => {
  if (v === null || typeof v !== "object") throw new BoatFailure({ kind: "network", message: "boat's sandbox: invalid type: null, expected struct Sandbox" });
  const s = v as Partial<Sandbox>;
  return { ...s, id: typeof s.id === "string" ? s.id : "", state: typeof s.state === "string" ? s.state : "", labels: s.labels ?? {} } as Sandbox;
};

/** boat.dev over HTTPS. */
export class RestBoat implements Boat {
  readonly api: string;

  constructor(
    api: string,
    private readonly key: () => string,
  ) {
    this.api = api.replace(/\/+$/, "");
  }

  private async call(method: string, path: string, query: [string, string][], headers: Record<string, string>, body?: Uint8Array | string): Promise<Record<string, unknown>> {
    let key: string;
    try {
      key = this.key();
    } catch (e) {
      throw e instanceof BoatFailure ? e : new BoatFailure({ kind: "no_key", message: (e as Error).message });
    }
    const url = new URL(`${this.api}${path}`);
    for (const [k, v] of query) url.searchParams.append(k, v);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${key}`, "user-agent": "fleetd", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new BoatFailure({ kind: "network", message: (e as Error).message });
    }
    const ra = res.headers.get("retry-after")?.trim();
    const retryAfter = ra !== undefined && /^[0-9]+$/.test(ra) ? Number(ra) : undefined;
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new BoatFailure({ kind: "network", message: (e as Error).message });
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (res.status >= 200 && res.status < 300) {
      if (parsed === null) throw new BoatFailure({ kind: "network", message: `boat answered ${res.status} without JSON` });
      return parsed as Record<string, unknown>;
    }
    throw new BoatFailure(refusal(res.status, parsed, retryAfter));
  }

  async create(idemKey: string, body: Uint8Array): Promise<Sandbox> {
    return sandboxOf((await this.call("POST", "/sandboxes", [], { "idempotency-key": idemKey }, body)).sandbox ?? null);
  }

  async get(id: string): Promise<Sandbox> {
    return sandboxOf((await this.call("GET", `/sandboxes/${id}`, [], {})).sandbox ?? null);
  }

  async list(labels: [string, string][]): Promise<Sandbox[]> {
    const all: Sandbox[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const query: [string, string][] = labels.map(([k, v]) => ["label", `${k}=${v}`]);
      query.push(["limit", String(PAGE)]);
      if (cursor !== undefined) query.push(["cursor", cursor]);
      const body = await this.call("GET", "/sandboxes", query, {});
      const page = body.sandboxes ?? [];
      if (!Array.isArray(page)) throw new BoatFailure({ kind: "network", message: "boat's list: invalid type: expected a sequence" });
      all.push(...page.map(sandboxOf));
      const info = (body.pageInfo ?? {}) as { hasMore?: unknown; nextCursor?: unknown };
      cursor = typeof info.nextCursor === "string" ? info.nextCursor : undefined;
      if (info.hasMore !== true || cursor === undefined) return all;
    }
    throw new BoatFailure({ kind: "network", message: `boat's list ran past ${MAX_PAGES} pages; read none of it` });
  }

  async setTtl(id: string, ttl: Ttl): Promise<void> {
    await this.call("PATCH", `/sandboxes/${id}`, [], {}, JSON.stringify({ ttlSeconds: ttl.seconds }));
  }

  async stop(id: string): Promise<void> {
    await this.call("POST", `/sandboxes/${id}/stop`, [], {}, "{}");
  }

  async resume(id: string, ttl: Ttl): Promise<Sandbox> {
    const body = await this.call("POST", `/sandboxes/${id}/resume`, [], {}, JSON.stringify({ ttlSeconds: ttl.seconds, failFast: true, noEnv: true }));
    const alreadyRunning = body.status === "running";
    // The answer's sandbox can be null; the id is the one resumed.
    let sb: Sandbox;
    try {
      sb = sandboxOf(body.sandbox ?? null);
    } catch {
      sb = { id: "", state: "", labels: {} };
    }
    return { ...sb, id: sb.id === "" ? id : sb.id, alreadyRunning };
  }

  async delete(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/sandboxes/${id}`, [], { "x-ascii-confirm-delete": id });
    } catch (e) {
      if (!(e instanceof BoatFailure && e.error.kind === "not_found")) throw e;
    }
  }

  async limits(): Promise<Limits> {
    const b = await this.call("GET", "/limits", [], {});
    return {
      canStart: b.canStart === true,
      startBlockedReason: (b.startBlockedReason as string | null | undefined) ?? null,
      nextStartDollars: typeof b.nextStartDollars === "number" ? b.nextStartDollars : null,
      activeSandboxes: typeof b.activeSandboxes === "number" ? b.activeSandboxes : 0,
      maxActiveSandboxes: typeof b.maxActiveSandboxes === "number" ? b.maxActiveSandboxes : 0,
      startLimits: (b.startLimits as StartLimits | null | undefined) ?? null,
      sandboxPlanDollars: typeof b.sandboxPlanDollars === "number" ? b.sandboxPlanDollars : null,
      machineTypes: Array.isArray(b.machineTypes) ? (b.machineTypes as MachineType[]) : [],
    };
  }

  async sshKey(id: string, publicKey: string): Promise<SshAccess> {
    return (await this.call("POST", `/sandboxes/${id}/sshkey`, [], {}, JSON.stringify({ key: publicKey }))) as SshAccess;
  }

  async usage(id: string, sinceMs: number): Promise<number> {
    const body = await this.call("GET", `/sandboxes/${id}/usage`, [["since", isoMs(sinceMs)]], {});
    if (typeof body.dollars !== "number") throw new BoatFailure({ kind: "network", message: "boat's usage had no dollars" });
    return body.dollars;
  }
}
