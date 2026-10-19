// The two plain-HTTP requests the app makes outside the /app socket: GET /healthz to find a hub and POST /pair to
// trade a code for a key. Both run in main; the renderer has no network.
import { z } from "zod";
import { LOCAL_HUB, type PairFailure, type Probe } from "../../shared/pairing";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const PAIR_TIMEOUT_MS = 15_000;

const Paired = z.object({ key: z.string().min(1), hubUrl: z.string(), hubName: z.string() });
export type Paired = z.infer<typeof Paired>;

const HubFailure = z.object({ code: z.string(), message: z.string().min(1), fix: z.string().optional() });

const Healthz = z.object({ ok: z.literal(true), version: z.string(), protocol: z.int() });

const CHECK_ADDRESS = `Check the address is your fleetd hub's, e.g. ${LOCAL_HUB}.`;

/** Network-level failures in words, with what to check. */
const unreachable = (origin: string, error: unknown): PairFailure => {
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  return {
    code: "",
    message: timedOut ? `${origin} didn't answer within ${PAIR_TIMEOUT_MS / 1000} s.` : `Can't reach ${origin}.`,
    fix: "Check the hub is running (`fleetd doctor` on the hub) and that this address is reachable from this computer.",
  };
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/** Whether a fleetd hub answers at `origin`, and which version and protocol it runs. Never throws. */
export const probe = async (fetch: Fetch, origin: string, timeoutMs: number): Promise<Probe> => {
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    const health = Healthz.safeParse(await readJson(response));
    if (response.ok && health.success) {
      return { answers: true, hub: origin, version: health.data.version, protocol: health.data.protocol };
    }
  } catch {
    // Nothing there, or not a hub: both read as "no hub answers".
  }
  return { answers: false, hub: origin };
};

/** `POST <origin>/pair`. No auth header: the code is the credential. */
export const redeem = async (
  fetch: Fetch,
  origin: string,
  code: string,
  deviceName: string,
): Promise<{ ok: true; paired: Paired } | { ok: false; failure: PairFailure }> => {
  let response: Response;
  try {
    response = await fetch(`${origin}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    return { ok: false, failure: unreachable(origin, error) };
  }
  const body = await readJson(response);
  if (response.ok) {
    const paired = Paired.safeParse(body);
    return paired.success
      ? { ok: true, paired: paired.data }
      : { ok: false, failure: { code: "", message: `${origin} answered, but not like a fleetd hub.`, fix: CHECK_ADDRESS } };
  }
  const failure = HubFailure.safeParse(body);
  if (failure.success) {
    const { code: hubCode, message, fix } = failure.data;
    return { ok: false, failure: fix === undefined ? { code: hubCode, message } : { code: hubCode, message, fix } };
  }
  return {
    ok: false,
    failure:
      response.status === 404
        ? {
            code: "",
            message: `${origin} doesn't take pairing codes.`,
            fix: "If this is your hub, update it (`fleetd update` on the hub), or use a key instead.",
          }
        : { code: "", message: `${origin} answered HTTP ${response.status} to pairing.`, fix: CHECK_ADDRESS },
  };
};
