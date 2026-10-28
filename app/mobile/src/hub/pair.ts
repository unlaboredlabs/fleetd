// Pairing, as the desktop app pairs (app/desktop/src/main/pairing): the person types the hub's address and a code
// from `fleetd pair` on the hub, and `POST <hub>/pair {code, deviceName}` trades it for this phone's own key. No auth
// header: the code is the credential.
import { hubOrigin, normalizeCode, type PairFailure } from "../desktop";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const PAIR_TIMEOUT_MS = 15_000;

export interface Paired {
  /** The hub's origin as typed, which the app connects to (the hub's own idea of its URL may not be reachable here). */
  readonly hub: string;
  readonly key: string;
  readonly hubName: string;
}

export type PairResult = { readonly ok: true; readonly paired: Paired } | { readonly ok: false; readonly failure: PairFailure };

const NEW_CODE = "Run `fleetd pair` on the hub and type the code it prints.";

const failed = (message: string, fix?: string): PairResult => ({ ok: false, failure: fix === undefined ? { code: "", message } : { code: "", message, fix } });

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

const str = (v: unknown): v is string => typeof v === "string";

export const pair = async (fetch: Fetch, hub: string, typed: string, deviceName: string): Promise<PairResult> => {
  const origin = hubOrigin(hub);
  if (!origin.ok) return { ok: false, failure: origin.failure };
  const code = normalizeCode(typed);
  if (code === null) return failed("A pairing code is 8 letters and digits, like ABCD-2345.", NEW_CODE);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PAIR_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${origin.origin}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
      signal: abort.signal,
    });
  } catch {
    return failed(
      abort.signal.aborted ? `${origin.origin} didn't answer within ${String(PAIR_TIMEOUT_MS / 1000)} s.` : `Can't reach ${origin.origin}.`,
      "Check the hub is running and that this phone reaches it: on a tailnet, that Tailscale is on.",
    );
  } finally {
    clearTimeout(timer);
  }
  const body = (await readJson(response)) as Record<string, unknown> | undefined;
  if (response.ok) {
    const { key, hubName } = body ?? {};
    return str(key) && key !== "" && str(hubName)
      ? { ok: true, paired: { hub: origin.origin, key, hubName } }
      : failed(`${origin.origin} answered, but not like a fleetd hub.`, "Check the address is your fleetd hub's.");
  }
  const { code: hubCode, message, fix } = body ?? {};
  if (str(hubCode) && str(message) && message !== "") {
    return { ok: false, failure: str(fix) ? { code: hubCode, message, fix } : { code: hubCode, message } };
  }
  return failed(`${origin.origin} answered ${String(response.status)}.`, "Check the address is your fleetd hub's.");
};
