// What the doctor's checks read from the hub (crates/fleetd/src/hub/usage/wire.rs, "What the doctor's checks read
// from the hub"): each through its area's own exported reads. The few that live in memory in an area not ported yet
// (the usage breaker, the tasks sweep's recovery breakers and unowned sessions, the cloud pool's facts) answer "all
// clear" until that area's owner sets its own: `doctor(hub).sources.usageBreaker = …`.
import type { MachineId } from "../../shared/contracts.ts";
import type { NodeLoad } from "../../shared/node_link.ts";
import type { RunnerInfo, WorktreeBase } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import { accounts } from "../claude_accounts/tools.ts";
import { executors, READ_TIMEOUT_MS } from "../executor/index.ts";
import { githubApps } from "../github_app/index.ts";
import { link } from "../link/index.ts";
import { token } from "../onepassword/index.ts";
import { active, people } from "../people/store.ts";
import { store } from "../store/hub_store.ts";
import { TaskRecords } from "../tasks/records.ts";
import { changeRecords } from "../train/index.ts";
import type {
  ClaudeSetupView,
  CloudFacts,
  MachineView,
  ProbeRead,
  RecoveryPaused,
  SetupFacts,
  UnownedSession,
  UsageBreaker,
} from "./checks.ts";

/** Why a Change waits for CI that doesn't exist (hub/train/batch.rs NO_CI). */
export const NO_CI =
  "held: this repo has no CI, and fleetd merges only on green CI. Add a GitHub Actions workflow that runs on pull requests; it goes on by itself once one exists.";

export type DoctorSources = {
  machines(): MachineView[];
  /** The runner as the node last reported it, else asked for now; undefined when it can't say. */
  runnerInfo(machineId: string): Promise<RunnerInfo | undefined>;
  usageBreaker(machineId: string): Promise<UsageBreaker>;
  /** The node's `probe` action, or why there is none. */
  probe(machineId: string): Promise<ProbeRead>;
  /** What the machine's node last reported with its heartbeat. */
  load(machineId: string): NodeLoad | undefined;
  /** Why the disk guard holds new agents on the machine, while it does. */
  paused(machineId: string): string | undefined;
  /** The other machines whose nodes run on the same computer as this one's. */
  sameComputer(machineId: string): string[];
  reposWithoutCi(): string[];
  setupFacts(): SetupFacts;
  /** Each project's latest worktree base on the machine, by the project's title. */
  bases(machineId: string): [string, WorktreeBase][];
  recoveryPaused(machineId: string): RecoveryPaused | undefined;
  claudeSetup(): ClaudeSetupView | undefined;
  unownedSessions(machineId: string): UnownedSession[];
  cloudFacts(): CloudFacts | undefined;
};

/** Logged and empty, as the Rust ports log a failed read and go on. */
function logged<T>(what: string, fallback: T, read: () => T): T {
  try {
    return read();
  } catch (error) {
    console.warn(`doctor: ${what} not read:`, error);
    return fallback;
  }
}

export function hubSources(hub: Hub): DoctorSources {
  const sources: DoctorSources = {
    machines: () =>
      logged("machines", [], () =>
        store(hub)
          .machinesList()
          .map((m) => ({
            machineId: m.machineId,
            status: m.status,
            lastSeenAt: m.lastSeenAt,
            ...(m.degradedReason === undefined ? {} : { degradedReason: m.degradedReason }),
            ...(m.agentsMac === undefined ? {} : { agentsMac: m.agentsMac }),
          })),
      ),
    async runnerInfo(machineId) {
      const ex = executors(hub);
      const cached = ex.cachedRunner(machineId as MachineId);
      if (cached) return cached;
      try {
        const out = await ex.call(machineId as MachineId, "read", { op: "runner_info" }, READ_TIMEOUT_MS);
        if (out.kind !== "runner_info") return undefined;
        const { kind: _kind, ...info } = out;
        return info as RunnerInfo;
      } catch {
        return undefined;
      }
    },
    // The usage area keeps its breakers in memory (hub/usage/service.rs); until it is ported, every one is closed.
    usageBreaker: async () => ({ state: "closed" }),
    async probe(machineId) {
      try {
        // Its `id` is set by the request.
        const frame = await link(hub).request(machineId, { t: "node_action", id: "", action: "probe" }, { waitSec: 30 });
        if (frame.probe) return { ok: true, probe: frame.probe };
        return { ok: false, why: `${machineId}'s node did not probe: ${frame.message}` };
      } catch (error) {
        return { ok: false, why: (error as Error).message };
      }
    },
    load: (machineId) => link(hub).load(machineId),
    paused: (machineId) => link(hub).paused(machineId),
    sameComputer(machineId) {
      const print = (id: string) => hub.auth.nodes.nodeFingerprint(id);
      const ours = logged("a node's fingerprint", undefined, () => print(machineId));
      if (ours === undefined) return [];
      return logged("machines", [], () =>
        store(hub)
          .machinesList()
          .map((m) => m.machineId as string)
          .filter((id) => id !== machineId && print(id) === ours)
          .sort(),
      );
    },
    reposWithoutCi: () =>
      logged("the trains", [], () => {
        const records = changeRecords(hub);
        return records
          .trains()
          .map((t) => t.repo)
          .filter((repo) => records.inTrain(repo, ["ready"]).some((c) => c.lastError === NO_CI))
          .sort();
      }),
    setupFacts: () => ({
      joined: logged("people", [], () => people(hub).joined()),
      ...optional("githubApp", logged("the GitHub App", undefined, () => githubApps(hub).get())),
      ...optional("cloud", sources.cloudFacts()),
      onepassword: logged("1Password tokens", [], () =>
        active(hub.db).flatMap((p) => {
          const saved = token(hub.db, p.personId);
          return saved ? [[p.name, saved.lastTest ?? undefined] as [string, typeof saved.lastTest]] : [];
        }),
      ) as SetupFacts["onepassword"],
    }),
    bases: (machineId) =>
      logged("worktree bases", [], () =>
        TaskRecords.latestBases(hub.db.conn, machineId).map(([r, base]): [string, WorktreeBase] => [
          store(hub).projectGet(r)?.title ?? r.projectId,
          base,
        ]),
      ),
    // The tasks sweep keeps its recovery breakers and the unowned sessions in memory (hub/tasks/sweep.rs).
    recoveryPaused: () => undefined,
    claudeSetup: () =>
      logged("the hub's Claude accounts", undefined, () => {
        const setup = accounts(hub).setup();
        const owner = active(hub.db).find((p) => p.personId === setup.owner);
        // The agents' Mac holds no Claude account (D298): no check waits for one there.
        const machines = store(hub)
          .machinesList()
          .filter((m) => m.agentsMac !== true)
          .map((m) => m.machineId as string);
        const view: ClaudeSetupView = { configured: setup.configured(), machines };
        if (setup.hubApi) view.hubApi = setup.hubApi;
        if (owner) view.owner = [owner.name, setup.subscriptions.get(owner.personId)];
        return view;
      }),
    unownedSessions: () => [],
    // The cloud pool's facts need its ledger and budget (hub/pool/view.rs `facts`); none before it is ported.
    cloudFacts: () => undefined,
  };
  return sources;
}

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
