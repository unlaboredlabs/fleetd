// The update's ports over the running hub (crates/fleetd/src/hub/update/ports.rs): the release feed, this machine's
// binary and service, and the nodes over the link.
import claudeVersionRs from "../../../../../crates/fleetd/src/node/runner/claude/version.rs" with { type: "text" };
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { start as startWatcher } from "../../update/finish.ts";
import { baseUrl, cliAsset, HttpFeed, installedExe, runningBinary } from "../../update/index.ts";
import { isHubService, services } from "../../update/service.ts";
import type { NodeActionResult, NodeAnswer, NodeFacts, UpdatePorts } from "./index.ts";

/** The Claude Code version this fleetd was tested with (node/runner/claude/version.rs `TESTED`). */
export const CLAUDE_TESTED = /pub const TESTED: &str = "([^"]+)";/.exec(claudeVersionRs)?.[1] ?? "";

/** Where the watcher asks `/healthz`: loopback for every interface, an IPv6 address in brackets (doctor's `self_url`). */
export function healthUrl(host: string, port: number): string {
  let h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  h = h === "0.0.0.0" || h === "" ? "127.0.0.1" : h === "::" ? "::1" : h;
  return h.includes(":") ? `http://[${h}]:${port}` : `http://${h}:${port}`;
}

/** What runs on the machine that its node's restart would end (machine_roles `live_on`), when that area says. */
function busy(hub: Hub, machineId: string): string | undefined {
  const liveOn = hub.peek<(m: string) => number>("machine_roles_live");
  const n = liveOn?.(machineId) ?? 0;
  return n === 0 ? undefined : n === 1 ? "1 live session" : `${n} live sessions`;
}

const result = (frame: Record<string, unknown>): NodeActionResult => ({
  ok: frame.ok === true,
  message: typeof frame.message === "string" ? frame.message : "",
  ...(typeof frame.stage === "string" ? { stage: frame.stage } : {}),
  ...(typeof frame.steps === "number" ? { steps: frame.steps } : {}),
});

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function hubPorts(hub: Hub): UpdatePorts {
  const commands = () => link(hub).commands;
  return {
    feed: (channel) => new HttpFeed(baseUrl(channel)),
    running: () => VERSION,
    releaseBuild: () => process.env.FLEETD_VERSION !== undefined,
    exe: installedExe,
    asset: cliAsset,
    hubService: (exe) => services(exe).find(isHubService),
    previous: runningBinary,
    healthUrl: () => healthUrl(hub.config.listen.host, hub.config.listen.port),
    startWatcher,
    nodes(): NodeFacts[] {
      const l = link(hub);
      const ex = executors(hub);
      return store(hub)
        .machinesList()
        .map((m) => {
          const claude = ex.cachedRunner(m.machineId)?.version;
          const live = ex.liveSince(m.machineId);
          const facts: NodeFacts = {
            machineId: m.machineId,
            name: m.name,
            version: m.nodeVersion,
            canUpdate: l.can(m.machineId, "self_update"),
            canFetch: l.can(m.machineId, "update_fetch"),
            canHold: l.can(m.machineId, "update_hold"),
            canInstallClaude: l.can(m.machineId, "claude_install"),
            agentsMac: l.can(m.machineId, "agents_mac"),
          };
          if (live !== undefined) facts.liveSince = live;
          if (typeof claude === "string") facts.claude = claude;
          const b = busy(hub, m.machineId);
          if (b !== undefined) facts.busy = b;
          return facts;
        });
    },
    fetchOnNode(machineId, update) {
      commands()
        .fetchUpdate(machineId, update)
        .catch((e: unknown) => console.info(`update: the node ${machineId} didn't take the fetch: ${words(e)}`));
    },
    claudeTarget: () => CLAUDE_TESTED,
    async installClaude(machineId, version) {
      try {
        return result((await commands().installClaude(machineId, version)) as Record<string, unknown>);
      } catch (e) {
        throw new Error(words(e));
      }
    },
    async holdNode(machineId) {
      try {
        return result((await commands().holdNode(machineId)) as Record<string, unknown>).steps ?? 0;
      } catch (e) {
        throw new Error(words(e));
      }
    },
    nodeChanged(machineId) {
      return executors(hub).live.changed(machineId);
    },
    async updateNode(machineId, update): Promise<NodeAnswer> {
      let second: NodeActionResult | undefined;
      try {
        const [first] = await commands().updateNode(machineId, update, (frame) => {
          second = result(frame as Record<string, unknown>);
        });
        return [result(first as Record<string, unknown>), { tryTake: () => second }];
      } catch (e) {
        throw new Error(words(e));
      }
    },
  };
}
