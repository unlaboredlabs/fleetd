// The team's own hosted sandbox accounts on a machine that runs agents (W688): Settings' Test of a provider's key, and
// the team's limits, which the heartbeat turns into the agents this machine may run in hosted sandboxes past its own
// slots (`load.hostedMax`, which the hub adds to its cap: hub/slots/sizing.ts). The hub seals a key to this node for a
// check only; it never reaches an agent's session. Until a hosted kind lands (HOSTED_KINDS is empty), the limits are
// kept and reported as none: connecting a provider changes neither where agents run nor the cap.
import type { KnownSandboxCheckReason, KnownSandboxProvider } from "../../shared/contracts.ts";
import type { NodeAction, NodeActionResult } from "../../shared/node_link.ts";
import { CAP_SANDBOX, CHECK_WAIT, hostedMax, isProvider, type Limit, NAMES, PROVIDERS, reasonOf } from "../../shared/sandbox.ts";
import type { Node } from "../api.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { type ClientOptions, type Provider, provider as realProvider, type ProviderAuth, ProviderError, type ProviderId } from "../../sandbox/providers/index.ts";

/** The providers this node's sessions can run in (the hosted kind's): none until it lands. */
export const HOSTED_KINDS: readonly KnownSandboxProvider[] = [];

type Opener = { open(sealed: Uint8Array): Uint8Array | null };

/** A provider's client as Test uses it: only its list of fleetd's boxes. */
export type Lister = (id: ProviderId, auth: ProviderAuth, o?: ClientOptions) => Pick<Provider, "list">;

export class Sandboxes {
  #limits: Limit[] = [];

  constructor(
    private readonly box: Opener,
    private readonly kinds: readonly KnownSandboxProvider[] = HOSTED_KINDS,
    private readonly provider: Lister = realProvider,
  ) {}

  /** The team's limits the hub sent last, in the order agents go to the providers. */
  get limits(): readonly Limit[] {
    return this.#limits;
  }

  /** Agents this machine may run in hosted sandboxes past its own slots, by count alone. */
  hostedMax(): number {
    return hostedMax(this.#limits, this.kinds);
  }

  /** `node_action` sandbox_limits: the team's connected providers' limits, kept in PROVIDERS' order. */
  setLimits(frame: NodeAction): NodeActionResult {
    const given = Array.isArray(frame.limits) ? frame.limits : [];
    this.#limits = PROVIDERS.flatMap((p) => {
      const l = given.find((g) => g?.provider === p);
      const max = Number(l?.max);
      return l && Number.isFinite(max) && max >= 0 ? [{ provider: p, max: Math.trunc(max) }] : [];
    });
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

/** Linux machines that run agents: the capability, and the heartbeat's `load.hostedMax` while it is above 0. */
export function start(node: Node): Sandboxes | undefined {
  if (process.platform !== "linux") return undefined;
  const s = new Sandboxes(loadOrCreateBoxKey(node.home));
  byNode.set(node, s);
  node.area("caps").contribute(() => [CAP_SANDBOX]);
  node.area("hb").contribute((hb) => {
    const max = s.hostedMax();
    if (hb.load && max > 0) hb.load.hostedMax = max;
  });
  return s;
}
