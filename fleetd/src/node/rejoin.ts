// A machine moving with its hub (Move to the cloud, hub/transfer/move.ts): the hub it is linked to sends `node_action`
// `rejoin` with the new hub's address and a one-time code naming this machine. The node enrols there first, on a link
// of its own with the same identity key, as `fleetd init --join … --rejoin` would; only once the new hub has welcomed
// it does node.json name the new hub, and the node ends so that its service starts it again there. A code refused or a
// hub not reached leaves node.json as it was: the node stays on its hub, which hears why and can send a fresh code.
// The code is used in memory and never stored.
import type { NodeConfig } from "./config.ts";
import type { NodeIdentity } from "./identity.ts";
import { runNode } from "./link/index.ts";

/** How long the new hub has to welcome the node. */
export const REJOIN_WAIT_MS = 60_000;

export type RejoinAsk = { hub: string; code: string };

/** The hub's ask, checked: an https origin (http only on 127.0.0.1, for tests) and a code; or why not. */
export function readRejoin(raw: unknown, current: string): RejoinAsk | string {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const { hub, code } = r;
  if (typeof hub !== "string" || !/^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/127\.0\.0\.1:\d{1,5})$/.test(hub)) return "the new hub's address isn't one";
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(code)) return "the code isn't one";
  if (hub === current.replace(/\/+$/, "")) return "that is this machine's hub already";
  return { hub, code };
}

export type EnrolPorts = {
  config: NodeConfig;
  identity: NodeIdentity;
  boxPubKey?: string;
  machineFingerprint?: string;
  nodeVersion: string;
  waitMs?: number;
};

/** Enrols this machine at `ask.hub` with its code: ok once welcomed, else the new hub's refusal or that it wasn't reached. */
export async function enrolAt(ask: RejoinAsk, p: EnrolPorts): Promise<{ ok: true } | { ok: false; message: string }> {
  const stop = new AbortController();
  let welcomed = false;
  let onWelcome: () => void = () => {};
  const welcome = new Promise<"welcomed">((resolve) => (onWelcome = () => resolve("welcomed")));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), p.waitMs ?? REJOIN_WAIT_MS)));
  const linked = runNode({
    settings: { hub: ask.hub, machineId: p.config.machineId, name: p.config.name, nodeVersion: p.nodeVersion },
    identity: p.identity,
    ...(p.boxPubKey === undefined ? {} : { boxPubKey: p.boxPubKey }),
    ...(p.machineFingerprint === undefined ? {} : { machineFingerprint: p.machineFingerprint }),
    enrollToken: ask.code,
    onEnrolled: () => {
      welcomed = true;
      onWelcome();
    },
    // A link only to enrol: it lists nothing and takes nothing.
    capabilities: () => [],
    heartbeat: async () => ({}),
    attach: () => () => {},
    handle: () => {},
    log: () => {},
    signal: stop.signal,
  });
  try {
    // Welcomed is enrolled: the link is let go at once, not waited for.
    const end = await Promise.race([linked, welcome, timedOut]);
    if (welcomed) return { ok: true };
    if (end === "timeout" || end === "welcomed") return { ok: false, message: "the new hub didn't answer within a minute" };
    return { ok: false, message: end === undefined ? "the new hub closed the link" : `the new hub refused it: ${end.message.replace(/^hub refused this node: /, "")}` };
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}

/** node.json once enrolled at the new hub: its address, enrolled. */
export const movedConfig = (config: NodeConfig, hub: string): NodeConfig => {
  const { removed: _removed, ...rest } = config;
  return { ...rest, hub, enrolled: true };
};
