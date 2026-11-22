// The team's own hosted sandbox accounts on a machine that runs agents (W688): Settings' Test of a provider's key, and
// the team's limits and keys, sealed to this node's box key, with which it makes agents' boxes (./remote/boxes.ts).
// The heartbeat names the providers it holds keys for (`load.sandboxes`); the hub's slot board places agents there by
// count once this machine's own slots are full. A key never reaches an agent's session or a box.
import type { KnownSandboxCheckReason, KnownSandboxProvider } from "../../shared/contracts.ts";
import type { NodeAction, NodeActionResult } from "../../shared/node_link.ts";
import { CAP_SANDBOX, CHECK_WAIT, isProvider, type Limit, NAMES, ORDER, reasonOf } from "../../shared/sandbox.ts";
import type { Node } from "../api.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { type ClientOptions, type Provider, provider as realProvider, type ProviderAuth, ProviderError, type ProviderId } from "../../sandbox/providers/index.ts";
import { Boxes, boxes as currentBoxes, hostable, knownBoxes, setBoxes } from "./remote/boxes.ts";
import { join } from "node:path";
import { endHosted, KEPT, keptBoxes, retryKept } from "../place/hosted.ts";

type Opener = { open(sealed: Uint8Array): Uint8Array | null };

/** A provider's client as Test uses it: only its list of fleetd's boxes. */
export type Lister = (id: ProviderId, auth: ProviderAuth, o?: ClientOptions) => Pick<Provider, "list">;

export class Sandboxes {
  #limits: Limit[] = [];
  /** The keys the hub sent last: a disconnect's waits for its sessions to end, unless newer ones came meanwhile. */
  #sent = 0;

  constructor(
    private readonly box: Opener,
    private readonly provider: Lister = realProvider,
    /** Where the keys go, for the hosted place's boxes. */
    private readonly boxes?: Pick<Boxes, "setKeys" | "usable" | "retry" | "connected">,
  ) {}

  /** The team's limits the hub sent last, in the order agents go to the providers. */
  get limits(): readonly Limit[] {
    return this.#limits;
  }

  /** The connected providers this node can make boxes in: it holds their keys. */
  placeable(): KnownSandboxProvider[] {
    // An arm64 machine's fleetd can't run in a box (x86_64): it offers none, and Test still checks the key.
    if (!hostable()) return [];
    const held = this.boxes?.usable() ?? [];
    return this.#limits.map((l) => l.provider).filter((p) => held.includes(p));
  }

  /** The provider the hub's runner puts a session in that the hub placed nowhere: the first it can make boxes in now,
   * else the first it holds a key for that is set aside, whose start then fails saying why (not that none is connected). */
  forRunner(): KnownSandboxProvider | undefined {
    if (!hostable()) return undefined;
    const held = this.boxes?.connected() ?? [];
    return this.placeable()[0] ?? this.#limits.map((l) => l.provider).find((p) => held.includes(p));
  }

  /** `node_action` sandbox_limits: the team's connected providers' limits, kept in ORDER. */
  setLimits(frame: NodeAction): NodeActionResult {
    const given = Array.isArray(frame.limits) ? frame.limits : [];
    this.#limits = ORDER.flatMap((p) => {
      const l = given.find((g) => g?.provider === p);
      const max = Number(l?.max);
      return l && Number.isFinite(max) && max >= 0 ? [{ provider: p, max: Math.trunc(max) }] : [];
    });
    if (frame.keys && typeof frame.keys === "object") {
      const keys = frame.keys;
      const sent = ++this.#sent;
      // A provider whose key goes ends its live sessions first, their work brought back, while the key still deletes
      // their boxes; it takes no new ones meanwhile, being out of the limits.
      const gone = (this.boxes?.connected() ?? []).filter((p) => !keys[p]);
      const ending = gone.flatMap((p) => endHosted(p, `the team's key for ${NAMES[p]} was disconnected, so its sandbox was ended with its work saved`));
      if (ending.length === 0) this.boxes?.setKeys(keys);
      else void Promise.allSettled(ending).then(() => this.#sent === sent && this.boxes?.setKeys(keys));
    }
    // The hub sends them when something changed (a key that works again, a limit, a relink): a provider set aside
    // after a failure is tried again for the next agent rather than at the end of its wait.
    this.boxes?.retry();
    return { id: frame.id, ok: true, message: `${this.#limits.length} hosted providers' limits kept` };
  }

  /** `node_action` sandbox_check: the provider's list of fleetd's sandboxes with the key the hub sealed to this node. */
  async check(frame: NodeAction): Promise<NodeActionResult> {
    const no = (reason: KnownSandboxCheckReason, message: string): NodeActionResult => ({ id: frame.id, ok: false, reason, message: message.slice(0, 500) });
    if (!frame.sandbox) return no("failed", "the hub sent no key to test");
    const plain = this.box.open(new Uint8Array(Buffer.from(frame.sandbox, "base64")));
    if (!plain) return no("failed", "the key the hub sent didn't open on this machine");
    let parsed: { provider?: unknown; key?: unknown; domain?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(plain)) as typeof parsed;
    } catch {
      parsed = {};
    } finally {
      plain.fill(0);
    }
    const id = String(parsed.provider ?? "");
    const key = typeof parsed.key === "string" ? parsed.key : "";
    if (!isProvider(id) || key === "") return no("failed", "the hub sent no provider and key to test");
    const domain = typeof parsed.domain === "string" && parsed.domain !== "" ? parsed.domain : undefined;
    const signal = AbortSignal.timeout(CHECK_WAIT);
    try {
      const boxes = await this.provider(id, { key, ...(domain ? { domain } : {}) }, { signal }).list({ signal });
      return { id: frame.id, ok: true, message: `${NAMES[id]} answered for the key: ${boxes.length} of fleetd's sandboxes there` };
    } catch (e) {
      const message = masked((e as Error).message || String(e), key);
      if (e instanceof ProviderError) return no(reasonOf(e.reason), message);
      if (signal.aborted) return no("unreachable", `${NAMES[id]} didn't answer within ${CHECK_WAIT / 1000} seconds.`);
      return no("failed", message);
    }
  }
}

/** `text` with `key` taken out, should a client's words ever carry it. */
const masked = (text: string, key: string) => (key.length >= 4 ? text.split(key).join("…") : text);

const byNode = new WeakMap<Node, Sandboxes>();

/** The node's Sandboxes; undefined where agents never run in sandboxes (macOS, the agents' Mac). */
export const sandboxesOf = (node: Node): Sandboxes | undefined => byNode.get(node);

/** Linux machines that run agents: the capability, the boxes' keys and their reaper, and the heartbeat's
 * `load.sandboxes` while the node holds any key. */
export function start(node: Node): Sandboxes | undefined {
  if (process.platform !== "linux") return undefined;
  const key = loadOrCreateBoxKey(node.home);
  // Made before the sessions start (node/index.ts), so they re-adopt their boxes.
  const boxes = currentBoxes() ?? new Boxes(node.home, node.config.machineId, key);
  setBoxes(boxes);
  // Test lists with the provider's client the boxes are made with (a stand-in's, in tests).
  const s = new Sandboxes(key, boxes.o.provider ?? realProvider, boxes);
  byNode.set(node, s);
  node.area("caps").contribute(() => [CAP_SANDBOX]);
  node.area("hb").contribute((hb) => {
    const can = s.placeable();
    if (hb.load && can.length > 0) hb.load.sandboxes = can;
    const trouble = boxes.trouble();
    if (hb.load && trouble.length > 0) hb.load.sandboxTrouble = trouble;
  });
  // The boxes of this machine no session here holds any more (a crash between a box's create and its record, a
  // delete that failed) go, by their labels.
  boxes.startReaper(() => new Set([...knownBoxes(join(node.home, "hosts")), ...keptBoxes(node.home)]));
  // A box kept because its work didn't come back as it ended (place/hosted.ts `keep`): tried again now and at each sweep.
  void retryKept(node.home);
  setInterval(() => void retryKept(node.home), KEPT.everyMs).unref?.();
  return s;
}
