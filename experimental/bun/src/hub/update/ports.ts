// The update's ports over the running hub (crates/fleetd/src/hub/update/ports.rs): the release feed, this machine's
// binary and service, and the nodes over the link.
import claudeVersionRs from "../../../../../crates/fleetd/src/node/runner/claude/version.rs" with { type: "text" };
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import { approvals } from "../approvals/index.ts";
import { executors } from "../executor/index.ts";
import { link } from "../link/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { start as startWatcher } from "../../update/finish.ts";
import { baseUrl, cliAsset, HttpFeed, installedExe, runningBinary } from "../../update/index.ts";
import { isHubService, services } from "../../update/service.ts";
import { versionLabel } from "../../update/version.ts";
import type { HubUpdateData } from "../../shared/contracts.ts";
import type { Held, NodeActionResult, NodeAnswer, NodeFacts, UpdatePorts } from "./index.ts";

/** The Claude Code version this fleetd was tested with (node/runner/claude/version.rs `TESTED`). */
export const CLAUDE_TESTED = /pub const TESTED: &str = "([^"]+)";/.exec(claudeVersionRs)?.[1] ?? "";

/** Where the watcher asks `/healthz`: loopback for every interface, an IPv6 address in brackets (doctor's `self_url`). */
export function healthUrl(host: string, port: number): string {
  let h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  h = h === "0.0.0.0" || h === "" ? "127.0.0.1" : h === "::" ? "::1" : h;
  return h.includes(":") ? `http://[${h}]:${port}` : `http://${h}:${port}`;
}

/**
 * What runs on the machine that its node's restart would end: live sessions (machine_roles `live_on`, when that area
 * says), the approved commands running there (from the database, so one that ran across the hub's own restart counts
 * at once, before its node links again), and the checks and regenerations the hub runs there (the train's
 * `cmd_check`s). Agents' runs carry on by themselves, so they aren't in it.
 */
function busy(hub: Hub, machineId: string): string | undefined {
  const liveOn = hub.peek<(m: string) => number>("machine_roles_live");
  return busyWords(liveOn?.(machineId) ?? 0, approvals(hub).runningOn(machineId), link(hub).commands.checksRunning(machineId));
}

/** `busy` in words: "1 live session and 2 approved commands"; undefined when nothing runs. */
export function busyWords(sessions: number, approved: number, checks: number): string | undefined {
  const count = (n: number, one: string, many: string) => (n === 0 ? undefined : n === 1 ? `1 ${one}` : `${n} ${many}`);
  const words = [
    count(sessions, "live session", "live sessions"),
    count(approved, "approved command", "approved commands"),
    count(checks, "check", "checks"),
  ].filter((w) => w !== undefined);
  return words.length === 0 ? undefined : words.join(" and ");
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
          if (m.cloud) facts.cloud = true;
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
    async holdNode(machineId, unhosted): Promise<Held> {
      try {
        const frame = (await commands().holdNode(machineId, unhosted)) as Record<string, unknown>;
        return { steps: result(frame).steps ?? 0, ...(typeof frame.hosted === "number" ? { hosted: frame.hosted } : {}) };
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
    announce(update) {
      try {
        events(hub).append({
          at: isoMs(hub.clock.now()),
          type: "hub.update",
          summary: updateSummary(update),
          data: update,
        });
      } catch (e) {
        console.warn(`hub.update: ${words(e)}`);
      }
    },
  };
}

/** The `hub.update` event's line: the hub row's Updating… / Updated / Put back, in a sentence. */
export function updateSummary(update: HubUpdateData): string {
  const to = update.to !== undefined ? versionLabel(update.to) : "the newest build";
  switch (update.state) {
    case "updating": {
      if (update.hub === "restarting") return `Updating fleetd to ${to}: the hub restarts`;
      const restarting = update.machines.filter((m) => m.state === "restarting").length;
      if (restarting === 0) return `Updating fleetd to ${to}`;
      return restarting === 1 ? `Updating fleetd to ${to}: 1 machine restarts` : `Updating fleetd to ${to}: ${restarting} machines restart`;
    }
    case "updated":
      return `Updated fleetd to ${to}`;
    case "put_back":
      return `fleetd ${to} didn't come up healthy, so ${versionLabel(update.from)} was put back`;
    case "current":
      return `fleetd already runs ${to}`;
    default:
      return "fleetd didn't update";
  }
}
