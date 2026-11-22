// The team's Gemini API key (W809): gemini_key_set and gemini_key_remove, for an owner's or admin's device, kept the way
// the hub's Claude API key is. The app seals the key to each machine's box key; the hub relays each box to its node
// (`gemini_key`) and records the fingerprint it answers, never the key. Agents on Google whose bot has no
// GEMINI_API_KEY of its own run on it (node/sessions `#antigravity`); antigravity_status says where it is.
import type { ClaudeSealedOn } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_GEMINI_KEY } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { linked, nodeCan, offline } from "../link/node_port.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { administrator, refOf } from "./people.ts";
import { checkSeals } from "./setup.ts";
import { accounts, forgetSecret, relaySecret, type NodeSecret } from "./tools.ts";

const GEMINI: NodeSecret = {
  call: (set) => ({ op: "gemini_key", ...(set === undefined ? {} : { set }) }),
  ready: (hub, m) => {
    if (!linked(hub, m)) throw offline(m);
    if (!nodeCan(hub, m, CAP_GEMINI_KEY)) {
      throw new ToolError("invalid", `${m}'s node is too old to keep the team's Gemini key.`, `Update fleetd on ${m} and restart its node.`);
    }
  },
};

export function register(tools: Registry): void {
  tools.add("gemini_key_set", async (hub, caller, input) => {
    const by = admin(hub, caller);
    const seals = checkSeals(input.sealed ?? []);
    const endpoint = input.endpoint;
    if (endpoint !== undefined && !/^https?:\/\/[^\s]{1,500}$/.test(endpoint)) {
      throw new ToolError("invalid", "endpoint must be an http:// or https:// URL of at most 500 characters, no spaces.");
    }
    const s = accounts(hub);
    const before = s.geminiKey();
    if (seals.length === 0 && !before) throw new ToolError("invalid", "The team has no Gemini key to keep.", "Paste the key: the app seals it to each machine.");
    const [held, problems] = await relaySecret(hub, GEMINI, seals, endpoint, before?.sealedOn ?? []);
    if (held.length === 0) {
      throw new ToolError("failed", `No machine took it. ${problems.join(" ")}`, "Seal it to the machines while they are online, then save again.");
    }
    const key = { ...(endpoint !== undefined ? { endpoint } : {}), sealedOn: held, updatedAt: isoMs(hub.clock.now()), updatedBy: refOf(by) };
    s.putGeminiKey(key);
    const missing = missingOn(hub, held);
    return {
      geminiKey: key,
      ...(missing.length > 0 ? { missingOn: missing } : {}),
      next: [
        "Agents on Google started from now on run on it, unless their bot has a GEMINI_API_KEY of its own; a running agent keeps what it started on.",
        ...problems,
      ].join(" "),
    };
  });

  tools.add("gemini_key_remove", async (hub, caller) => {
    admin(hub, caller);
    const s = accounts(hub);
    const before = s.geminiKey();
    if (before) {
      s.removeGeminiKey();
      await forgetSecret(hub, GEMINI, before.sealedOn.map((x) => x.machineId), "the team's Gemini key");
    }
    return { ok: true, next: "Agents on Google run on their bot's own GEMINI_API_KEY, else each machine's Google sign-in, from their next start." };
  });
}

function admin(hub: Hub, caller: Caller) {
  const by = administrator(hub, caller);
  if (!by) {
    throw new ToolError("forbidden", "Only the hub's owners and admins set the team's Gemini key.", "Ask an owner or admin; they set it on the Providers page of the app's Settings.");
  }
  return by;
}

/** Machines that run agents and don't hold the key: agents on Google there run on their bot's key or the sign-in. */
const missingOn = (hub: Hub, held: ClaudeSealedOn[]) =>
  store(hub)
    .machinesList()
    .map((m) => m.machineId)
    .filter((m) => !held.some((s) => s.machineId === m));
