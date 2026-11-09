// POST /pair and POST /pair/mac (mac.rs `handle`). No auth header: the
// code is the credential, so failed attempts are rate limited per remote address.
import { isIP } from "node:net";
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import { hubId } from "../link/server.ts";
import { announce, change } from "../people/events.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { json, type Route } from "../http/route.ts";
import { FIRST_MAC, pairCodes, RedeemError } from "./codes.ts";
import { expand6, isUnspecified } from "./urls.ts";

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const MAX_DEVICE_NAME = 64;
const NEW_CODE_FIX = "Run `fleetd pair` on the hub for a new code, or ask whoever invited you for a new invite.";
const NEW_MAC_CODE_FIX = "On your main machine, open Add machine › A Mac for agents for a new code, then type it here.";

export type PairErrorCode = "pair_code_invalid" | "pair_code_expired" | "pair_rate_limited" | "invalid" | "mac_other_computer";

/**
 * Whose attempts count together: an IPv6 address's /64, which one client holds whole, and an IPv4 address as itself,
 * however it reached the listener (`::ffff:a.b.c.d` on a dual-stack one).
 */
export function bucket(addr: string | undefined): string {
  if (addr === undefined) return "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return mapped[1] as string;
  if (isIP(addr) !== 6) return addr;
  return `${expand6(addr).slice(0, 4).join(":")}::`;
}

/** Failed redeem attempts per remote address over the last minute. */
export class Limiter {
  private readonly failures = new Map<string, number[]>();

  blocked(addr: string | undefined, now: number): boolean {
    const times = this.failures.get(bucket(addr));
    if (!times) return false;
    const kept = times.filter((at) => now - at < FAILURE_WINDOW_MS);
    this.failures.set(bucket(addr), kept);
    return kept.length >= MAX_FAILURES;
  }

  failed(addr: string | undefined, now: number): void {
    if (this.failures.size > 1024) {
      for (const [key, times] of this.failures) {
        if (!times.some((at) => now - at < FAILURE_WINDOW_MS)) this.failures.delete(key);
      }
    }
    const key = bucket(addr);
    const times = this.failures.get(key) ?? [];
    times.push(now);
    this.failures.set(key, times);
  }
}

/** /pair's and /pair/mac's one limiter. */
export const limiter = (hub: Hub) => hub.area("pair_limiter", () => new Limiter());

export const pairError = (status: number, code: PairErrorCode, message: string, fix: string) =>
  json({ code, message, fix }, status);

export function storeFailed(error: unknown): Response {
  console.error("pairing failed:", error);
  return json(
    { code: "internal", message: "the hub could not record the pairing", fix: "Check the hub's log, then run `fleetd pair` again." },
    500,
  );
}

function deviceName(sent: string | undefined, minted: string | undefined): string {
  const trimmed = sent?.trim();
  const name = trimmed !== undefined && trimmed !== "" ? trimmed : (minted ?? "device");
  return [...name.replace(/\p{Cc}/gu, "")].slice(0, MAX_DEVICE_NAME).join("");
}

/**
 * Where the device should reach the hub from now on: the configured URL, else the address it just used when the hub
 * listens on every interface (`http://0.0.0.0:…` reaches nothing), else `http://<listen>`.
 */
export function hubUrl(hub: Hub, hostHeader: string | null): string {
  if (hub.config.url === undefined && hostHeader !== null && isUnspecified(hub.config.listen.host.replace(/^\[|\]$/g, ""))) return `http://${hostHeader}`;
  return hub.url();
}

/** The body as JSON, or why it isn't the object expected (serde's wording where it matters). */
async function body(req: Request, fields: Record<string, "required" | "optional">): Promise<Record<string, unknown> | string> {
  const text = await req.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return text.trim() === "" ? "EOF while parsing a value at line 1 column 0" : String((error as Error).message);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `invalid type: ${value === null ? "null" : Array.isArray(value) ? "sequence" : typeof value}, expected a struct`;
  }
  const obj = value as Record<string, unknown>;
  for (const [field, need] of Object.entries(fields)) {
    const v = obj[field];
    if (v === undefined || (v === null && need === "optional")) {
      if (need === "required") return `missing field \`${field}\``;
      continue;
    }
    if (typeof v !== "string") return `invalid type: ${v === null ? "null" : typeof v}, expected a string`;
  }
  return obj;
}

/** `POST /pair`. */
export const pair: Route = async (req, { hub, ip }) => {
  const now = hub.clock.now();
  const limit = limiter(hub);
  if (limit.blocked(ip, now)) {
    return pairError(429, "pair_rate_limited", "too many wrong pairing codes from this address", "Wait a minute, then try again.");
  }
  const request = await body(req, { code: "required", deviceName: "optional" });
  if (typeof request === "string") {
    return pairError(
      400,
      "invalid",
      `expected {"code": "XXXX-XXXX", "deviceName": "…"}: ${request}`,
      "Send the pairing code from `fleetd pair` as JSON.",
    );
  }
  let redeemed: ReturnType<ReturnType<typeof pairCodes>["redeem"]>;
  try {
    redeemed = pairCodes(hub).redeem(request.code as string);
  } catch (error) {
    if (!(error instanceof RedeemError)) return storeFailed(error);
    limit.failed(ip, now);
    return pairError(401, error.kind === "expired" ? "pair_code_expired" : "pair_code_invalid", error.message, NEW_CODE_FIX);
  }
  const name = deviceName(request.deviceName as string | undefined, redeemed.name);
  let created: ReturnType<Hub["auth"]["keys"]["createKeyFor"]>;
  try {
    created = hub.auth.keys.createKeyFor(name, [{ role: redeemed.role, machines: "*" }], "human", redeemed.personId);
  } catch (error) {
    return storeFailed(error);
  }
  const { key, info } = created;
  if (redeemed.inviteId !== undefined && info.person !== undefined) {
    announce(
      hub,
      { ...change("joined", info.person, undefined), inviteId: redeemed.inviteId, keyId: info.keyId },
      `${info.person.name} joined the hub on ${name}`,
    );
  }
  try {
    events(hub).append({
      at: isoMs(now),
      type: "key.paired",
      summary: `${name} paired with the hub`,
      data: { keyId: info.keyId, deviceName: name, personId: info.person?.personId ?? null, inviteId: redeemed.inviteId ?? null },
    });
  } catch (error) {
    console.warn("key.paired event not recorded:", error);
  }
  return json({ key, hubUrl: hubUrl(hub, req.headers.get("host")), hubName: hubId() });
};

/**
 * The machine a new Mac code is for: the hub's agents' Mac (the first by id, should there be two), else `mac`, else
 * `agents-mac` when a machine that isn't the Mac has that name.
 */
export function macMachineId(hub: Hub): string {
  const machines = store(hub)
    .machinesList()
    .sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
  const mac = machines.find((m) => m.agentsMac === true);
  if (mac) return mac.machineId;
  return machines.some((m) => m.machineId === FIRST_MAC) ? "agents-mac" : FIRST_MAC;
}

/** `POST /pair/mac`: the agents' Mac trades its six digits for a one-time enroll token. */
export const macPair: Route = async (req, { hub, ip }) => {
  const now = hub.clock.now();
  const limit = limiter(hub);
  if (limit.blocked(ip, now)) {
    return pairError(429, "pair_rate_limited", "too many wrong setup codes", "Wait a minute, then type the code again.");
  }
  const request = await body(req, { code: "required", fingerprint: "optional" });
  if (typeof request === "string") {
    return pairError(
      400,
      "invalid",
      `expected {"code": "123456"}: ${request}`,
      "Send the 6-digit code from Add machine › A Mac for agents as JSON.",
    );
  }
  const codes = pairCodes(hub);
  const fingerprint = request.fingerprint as string | undefined;
  let redeemed: { machine: string } | { refused: "other" };
  try {
    // A code for an agents' Mac that is another computer would enroll nothing: said now, before the code is spent.
    redeemed = codes.redeemMac(request.code as string, (machine) => {
      const theirs = hub.auth.nodes.nodeFingerprint(machine);
      return fingerprint !== undefined && theirs !== undefined && fingerprint !== theirs ? ("other" as const) : undefined;
    });
  } catch (error) {
    if (!(error instanceof RedeemError)) return storeFailed(error);
    limit.failed(ip, now);
    try {
      codes.failedMac();
    } catch (failed) {
      return storeFailed(failed);
    }
    return error.kind === "expired"
      ? pairError(401, "pair_code_expired", "that code expired", NEW_MAC_CODE_FIX)
      : pairError(401, "pair_code_invalid", "that code isn't open on this hub", NEW_MAC_CODE_FIX);
  }
  if ("refused" in redeemed) {
    return pairError(
      409,
      "mac_other_computer",
      "this hub's agents' Mac is another computer",
      "To make this Mac the agents' Mac instead, remove the old one on your main machine (Settings › Hub › " +
        "Machines › the Mac › Remove), then type this code again.",
    );
  }
  const machine = redeemed.machine;
  try {
    const existing = store(hub).machineGet(machine) !== undefined;
    const token = hub.auth.nodes.createEnrollToken(machine, "POST /pair/mac (the agents' Mac's setup code)");
    console.info(`the agents' Mac ${machine} traded its setup code`);
    return json({
      hubUrl: hubUrl(hub, req.headers.get("host")),
      hubName: hubId(),
      machineId: machine,
      token: token.token,
      expiresAt: token.expiresAt,
      version: VERSION,
      existing,
    });
  } catch (error) {
    return storeFailed(error);
  }
};
