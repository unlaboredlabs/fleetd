// The providers' HTTP calls, and what a refusal means in plain words. The key is sent only in the header the provider
// names, and masked out of anything a provider says back before it reaches a message.

/** Why a provider call failed, for the one who fixes it: the key, a plan limit, the account's billing, its start rate
 * (which frees by itself within a minute or so), the network, or anything else. Settings' Test picks its fix line by this. */
export type Reason = "invalid_key" | "limit" | "billing" | "rate" | "unreachable" | "failed";

export class ProviderError extends Error {
  constructor(
    readonly reason: Reason,
    message: string,
    /** The HTTP status, when the provider answered. */
    readonly status?: number,
    /** The provider's own error code, when it gave one (`idempotency_in_progress`). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** A provider's answer: its status, its JSON body (undefined when it isn't JSON) and its text. */
export type Answer = { status: number; headers: Headers; body: any; text: string };

/** What a provider's refusal means, when the status alone doesn't say (its own error codes). Undefined: by status. */
export type Refine = (a: Answer, said: string) => { reason: Reason; message: string } | undefined;

/** A single call's longest wait, unless the caller's signal ends it first. */
export const CALL_MS = 60_000;

/** `text` with the key cut out of it, and at most `max` characters. */
export function scrub(text: string, key: string, max = 300): string {
  let out = key.length >= 4 ? text.split(key).join("…") : text;
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** What the provider said about a failure: its message field, else the start of its text. */
function said(a: Answer): string {
  const b = a.body;
  const m = typeof b?.message === "string" ? b.message : typeof b?.error?.message === "string" ? b.error.message : typeof b?.error === "string" ? b.error : a.text;
  return m || `HTTP ${a.status}`;
}

/** The provider's own error code in a refusal's body. */
function codeOf(a: Answer): string | undefined {
  const b = a.body;
  const c = b?.error_code ?? b?.code ?? b?.error?.code;
  return typeof c === "string" ? c : undefined;
}

/** A failure by its status: the shared meaning of 401, 402, 403, 429 and 5xx. */
export function byStatus(name: string, a: Answer, words: string): ProviderError {
  const s = a.status;
  if (s === 401) return new ProviderError("invalid_key", `${name} refused the key: it is wrong, expired or revoked (${words}).`, s);
  if (s === 402) return new ProviderError("billing", `${name} won't run sandboxes on this account until its billing is sorted out (${words}).`, s);
  if (s === 403) return new ProviderError("invalid_key", `${name} says the key may not do this: it lacks a permission (${words}).`, s);
  if (s === 429) return new ProviderError("limit", `${name}'s limit for this account is reached (${words}).`, s);
  if (s === 502 || s === 504) return new ProviderError("unreachable", `${name} didn't answer in time (${words}); try again in a minute.`, s);
  if (s >= 500) return new ProviderError("failed", `${name} failed on its side (${words}); try again in a minute.`, s);
  return new ProviderError("failed", `${name} refused the call (${words}).`, s);
}

export type HttpOptions = {
  /** The provider's name in messages: "boat". */
  name: string;
  base: string;
  /** Sent on every call: the key's header. */
  headers: Record<string, string>;
  key: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  refine?: Refine;
};

export type CallOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Statuses besides 2xx that are an answer, not a failure (404 on a delete). */
  ok?: number[];
  /** Answers the response itself unread (a stream). */
  raw?: boolean;
  /** Another base for this call (a box's own host). Such a call carries only its own `headers`, never the key's. */
  base?: string;
  query?: Record<string, string | string[] | undefined>;
};

export class Http {
  readonly name: string;
  private readonly fetch: typeof fetch;
  constructor(readonly o: HttpOptions) {
    this.name = o.name;
    this.fetch = o.fetch ?? fetch;
  }

  url(path: string, base = this.o.base, query?: CallOptions["query"]): string {
    const u = new URL(base.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, one);
    }
    return u.toString();
  }

  /** The call's signal: the caller's, the client's and the call's longest wait together. */
  signal(own?: AbortSignal, ms = CALL_MS): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(ms), ...[own, this.o.signal].filter((s): s is AbortSignal => s !== undefined)]);
  }

  async call(method: string, path: string, c: CallOptions = {}): Promise<Answer & { res: Response }> {
    const url = this.url(path, c.base, c.query);
    const headers: Record<string, string> = { ...(c.base === undefined ? this.o.headers : {}), ...c.headers };
    let body: string | Uint8Array | undefined;
    if (c.body instanceof Uint8Array || typeof c.body === "string") body = c.body;
    else if (c.body !== undefined) {
      body = JSON.stringify(c.body);
      headers["content-type"] ??= "application/json";
    }
    let res: Response;
    try {
      res = await this.fetch(url, { method, headers, body, signal: this.signal(c.signal), redirect: "error" });
    } catch (e) {
      throw this.unreachable(url, e as Error, c.signal);
    }
    if (c.raw && res.ok) return { status: res.status, headers: res.headers, body: undefined, text: "", res };
    const text = await res.text().catch(() => "");
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const a = { status: res.status, headers: res.headers, body: parsed, text, res };
    if (res.ok || c.ok?.includes(res.status)) return a;
    throw this.failure(a);
  }

  failure(a: Answer): ProviderError {
    const words = scrub(said(a), this.o.key);
    const own = this.o.refine?.(a, words);
    const e = own ? new ProviderError(own.reason, own.message, a.status) : byStatus(this.name, a, words);
    return new ProviderError(e.reason, e.message, a.status, codeOf(a));
  }

  unreachable(url: string, e: Error, own?: AbortSignal): ProviderError {
    if (own?.aborted || this.o.signal?.aborted) return new ProviderError("failed", `the call to ${this.name} was cancelled`);
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    const why = e.name === "TimeoutError" ? `no answer within ${CALL_MS / 1000} seconds` : scrub(e.message, this.o.key, 160);
    return new ProviderError("unreachable", `couldn't reach ${this.name} at ${host}: ${why}`);
  }
}

/** Waits `ms`, or throws once `signal` ends. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError("failed", "cancelled"));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(t);
      reject(new ProviderError("failed", "cancelled"));
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}
