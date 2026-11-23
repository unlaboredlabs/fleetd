// The update's ports over the running hub: the release feed, this machine's
// binary and service, and the nodes over the link.
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
import { TESTED } from "../../node/runner/claude.ts";
import type { HubUpdateData } from "../../shared/contracts.ts";
import type { TrainArea } from "../train/index.ts";
import { CAP_BUILD_BUN, CAP_BUILD_RUST, CAP_UPDATE_BUILD } from "../../shared/node_link.ts";
import { leads } from "../leads/index.ts";
import { leadWorking } from "../chat/flow.ts";
import { death } from "../leads/cut_off.ts";
import { runGh } from "../train/gh.ts";
import { buildFeed } from "../../update/rollout.ts";
import type { HubEventType } from "../../shared/contracts.ts";
import type { Held, NodeActionResult, NodeAnswer, NodeFacts, UpdatePorts } from "./index.ts";

const LEAD_ENDS: HubEventType[] = ["thread.completed", "thread.failed", "thread.interrupted"];

/** The Claude Code version this fleetd was tested with. */
export const CLAUDE_TESTED = TESTED;

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
    buildFeed,
    running: () => VERSION,
    releaseBuild: () => process.env.FLEETD_VERSION !== undefined,
    exe: installedExe,
    asset: cliAsset,
    hubService: (exe) => services(exe).find(isHubService),
    previous: runningBinary,
    healthUrl: () => healthUrl(hub.config.listen.host, hub.config.listen.port),
    startWatcher,
    trainLandings: () => hub.peek<TrainArea>("merge_train")?.train.landings ?? 0,
    leadTurns: {
      mark: () => events(hub).head(),
      since(mark) {
        const threads = new Set(leads(hub).records.leadsList().map((l) => `${l.projectRef.machineId}/${l.threadId}`));
        let completed = 0;
        let failed = 0;
        for (let after = mark; ; ) {
          const page = events(hub).page(after, LEAD_ENDS);
          for (const e of page.events) {
            if (!threads.has(`${e.machineId}/${e.threadId}`)) continue;
            if (e.type === "thread.completed") completed++;
            // Only a turn cut off by its machine's link to the hub dropping, which a hub's build can cause; never one
            // Claude or its provider ended (a sign-in, an outage, a limit).
            else if (death(e.type, e.data as Record<string, unknown> | undefined, e.machineId ?? "").kind === "node_lost") failed++;
          }
          if (!page.more) break;
          after = page.cursor;
        }
        return { completed, failed };
      },
      working: () => leads(hub).records.leadsList().filter((l) => leadWorking(hub, l.projectRef)).length,
    },
    async reportPass(repo, build) {
      const out = await runGh("gh", ["workflow", "run", "rollout.yml", "-R", repo, "-f", "action=pass", "-f", `build=${build}`]);
      if (out.exitCode !== 0) throw new Error((out.stderr || out.stdout).trim() || `gh exited ${out.exitCode}`);
    },
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
            canPickBuild: l.can(m.machineId, CAP_UPDATE_BUILD),
            canInstallClaude: l.can(m.machineId, "claude_install"),
            agentsMac: l.can(m.machineId, "agents_mac"),
          };
          if (l.can(m.machineId, CAP_BUILD_BUN)) facts.flavour = "bun";
          else if (l.can(m.machineId, CAP_BUILD_RUST)) facts.flavour = "rust";
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
