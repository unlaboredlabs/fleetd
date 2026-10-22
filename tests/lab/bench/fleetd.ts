// The fleetd contender: a lab hub and one node on a lab slot (its ports, its local lock and its GitHub lease
// `lease/slot/<n>`), every home under the run dir in /tmp, the task's base copied to a run branch in the lab repo, that
// branch's clone added as the project, the project's max agents set, and the task text sent once as the person's chat
// message. Done is the lead saying the work is complete with its PRs merged into the run branch, and nothing running.
// No other human input: a run that stops to wait for a person ends as "stalled".
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { cloneBranch, gh, git, LAB_REPO, log, type RunInfo, type TaskDef } from "./benchVs.ts";
import { EFFORT, MODEL, pinnedSettings, writeClaudeShim } from "./env.ts";

type Body = Record<string, any>;
const MACHINE = "bench";
/** How often the done condition is evaluated; events wake the loop sooner. */
const EVAL_MS = 30_000;
/** Done must hold this long (a last lead wake may still open work). */
const SETTLE_MS = 90_000;
/** Nothing running, nothing open, not done, for this long: the run waits for a person. */
const STALL_MS = 15 * 60_000;
const WORKSTREAM_ENDED = new Set(["done", "stopped", "failed"]);
const TASK_ACTIVE = new Set(["queued", "running"]);

export interface FleetdRun {
  readonly task: TaskDef;
  readonly runDir: string;
  readonly runId: string;
  readonly slot: number;
  readonly maxAgents: number;
  readonly timeoutMs: number;
  readonly proxyUrl: string;
}

export async function runFleetd(opts: FleetdRun) {
  const { task, runDir, runId, slot } = opts;
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) throw new Error(`--slot must be 1-9, got ${slot}`);
  // The lab harness reads these at import: this run's slot, and its run dir (homes, logs) under /tmp.
  process.env.FLEETD_LAB_SLOT = String(slot);
  process.env.FLEETD_LAB_RUN = path.join(runDir, "lab");
  const h = await import("../harness.ts");
  h.requireGhLogin();
  h.takeLabLock();
  const lease = leaseSlot(slot);
  const runStamp = runId.slice(-15);
  const runBranch = `bench/${task.name}/run-${runStamp}/main`;
  const branchPrefix = `bench/${task.name}/run-${runStamp}/fleetd/`;
  const work = path.join(runDir, "work");
  const hubHome = path.join(h.RUN, "hub");
  const shimDir = path.join(runDir, "bin");
  const shimLog = path.join(runDir, "shim.log");
  const settings = pinnedSettings(opts.proxyUrl);
  const clients: Array<Client> = [];
  try {
    // The run branch: the frozen base, copied. PRs merge here; the base never moves.
    const baseSha = gh("api", `repos/${LAB_REPO}/commits/${encodeURIComponent(task.base)}`, "--jq", ".sha");
    gh("api", "-X", "POST", `repos/${LAB_REPO}/git/refs`, "-f", `ref=refs/heads/${runBranch}`, "-f", `sha=${baseSha}`, "--silent");
    cloneBranch(runBranch, work);
    git(work, "remote", "set-head", "origin", runBranch);
    fs.appendFileSync(path.join(work, ".git/info/exclude"), "\n.fleetd/\n");
    fs.mkdirSync(path.join(work, ".fleetd"), { recursive: true });
    // No areas: the hub infers them from the workspace, as for any user's repo.
    fs.writeFileSync(path.join(work, ".fleetd/policy.yaml"), `defaults:\n  model: ${MODEL}\n  effort: ${EFFORT}\nbranchPrefix: ${branchPrefix}\n`);
    log(`run branch ${runBranch} at ${baseSha.slice(0, 7)}; checkout ${work}`);

    // Hub and node, each with its own HOME holding the pinned copy of the user's claude setup, and a claude shim on
    // PATH that pins the model and effort of every print-mode call either of them starts.
    fs.mkdirSync(h.RUN, { recursive: true });
    writeClaudeShim(shimDir, shimLog);
    h.writeFleetdWrapper();
    h.prepareMachineHome("hub", { claudeSettings: settings });
    h.startCli("hub", ["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${h.HUB_PORT}`], {
      HOME: h.machineHome("hub"),
      PATH: `${shimDir}:${path.join(h.RUN, "bin")}:${process.env.PATH ?? ""}`,
    });
    await h.until("hub /healthz", 30_000, async () => {
      try {
        return (await fetch(`${h.HUB_URL}/healthz`)).ok ? true : undefined;
      } catch {
        await h.sleep(250);
        return undefined;
      }
    });
    const key = /fld_[a-z2-7]{20,}/u.exec(h.cli("hub", "key", "create", "--home", hubHome, "--name", "bench", "--role", "operate", "--machines", "*"))?.[0];
    const humanKey = /fld_[a-z2-7]{20,}/u.exec(h.cli("hub", "key", "create", "--home", hubHome, "--human", "--name", "bench-person"))?.[0];
    if (key === undefined || humanKey === undefined) throw new Error("hub key create printed no key");
    const connect = async (k: string) => {
      const client = new Client({ name: "fleetd-bench", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.HUB_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${k}` } } }) as Transport);
      clients.push(client);
      return h.callToolWith(() => client);
    };
    const call = await connect(key);
    const human = await connect(humanKey);
    const ok = async (name: string, args: Body = {}, as = call) => {
      const out = await as(name, args);
      if (out.isError) throw new Error(`${name}: ${JSON.stringify(out.body)}`);
      return out.body;
    };
    const cursor = async () => (await ok("fleetd_status")).cursor as number;
    const online = async () =>
      h.until(`${MACHINE} online`, 120_000, async () => {
        const s = await ok("fleetd_status");
        if ((s.machines as Array<Body>).some((m) => m.machineId === MACHINE && m.status === "online")) return true;
        await call("events_wait", { cursor: s.cursor, timeoutSec: 5 });
        return undefined;
      });

    const nodeOpts = { claudeSettings: settings, pathPrefix: [shimDir] };
    h.joinNode(h.HUB_URL, hubHome, MACHINE, nodeOpts);
    await online();
    // The node runs cmd checks only under its roots: the run dir, where the checkout is.
    await h.stopCli(`node-${MACHINE}`);
    h.setCmdRoots(MACHINE, [runDir]);
    h.startCli(`node-${MACHINE}`, ["node", "run", "--home", h.nodeHome(MACHINE)], {}, h.nodeEnv(MACHINE, nodeOpts));
    await online();
    const projectId = await h.until("project_add", 120_000, async () => {
      const added = await call("project_add", { machineId: MACHINE, path: work, title: task.name });
      if (!added.isError) return added.body.projectId as string;
      await call("events_wait", { cursor: await cursor(), timeoutSec: 3 });
      return undefined;
    });
    const projectRef = { machineId: MACHINE, projectId };
    await ok("cap_set", { project: { projectRef, maxAgents: opts.maxAgents } });
    log(`project ${projectId} on ${MACHINE}; max agents ${opts.maxAgents}; hub ${h.HUB_URL}`);

    const info: RunInfo = { runId, task: task.name, contender: "fleetd", runDir, work, baseSha, usageDirs: [] };
    const chatState = async () => ((await ok("chat_history", { projectRef, limit: 1 }, human)).state ?? {}) as Body;

    // The person's one message: the task. The clock starts here.
    let at = await cursor();
    const started = Date.now();
    info.startedAt = new Date(started).toISOString();
    await ok("chat_send", { projectRef, text: task.text, clientRequestId: randomUUID() }, human);
    log("task sent to the lead");

    let doneSince: number | undefined;
    let quietSince: number | undefined;
    let doneBy: "finished" | "timeout" | "stalled" = "timeout";
    let wallMs = opts.timeoutMs;
    let lastEval = 0;
    let lastLine = "";
    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed >= opts.timeoutMs) break;
      const page = (await call("events_wait", { cursor: at, timeoutSec: 25 })).body;
      at = (page.cursor as number | undefined) ?? at;
      if (Date.now() - lastEval < EVAL_MS) continue;
      lastEval = Date.now();
      const workstreams = (await ok("workstream_list", { machineId: MACHINE, projectId, limit: 100 })).workstreams as Array<Body>;
      const tasks = (await ok("tasks_list", { projectRef, limit: 100 })).tasks as Array<Body>;
      const prs = JSON.parse(gh("pr", "list", "-R", LAB_REPO, "--base", runBranch, "--state", "all", "--limit", "100", "--json", "number,state")) as Array<Body>;
      const requests = ((await ok("requests_list", { projectRef, limit: 100 })).requests as Array<Body>).filter((r) => r.state === "open");
      const chat = await chatState();
      const open = prs.filter((p) => p.state === "OPEN").length;
      const merged = prs.filter((p) => p.state === "MERGED").length;
      const active = tasks.filter((t) => TASK_ACTIVE.has(t.state)).length;
      const leadWorking = chat.leadWorking === true;
      const allEnded = workstreams.length > 0 && workstreams.every((w) => WORKSTREAM_ENDED.has(w.state)) && workstreams.some((w) => w.state === "done");
      const done = allEnded && active === 0 && open === 0 && merged > 0 && !leadWorking && requests.length === 0;
      const line = `workstreams ${workstreams.map((w) => w.state).join(",") || "none"}; agents ${active} active of ${tasks.length}; PRs ${open} open, ${merged} merged; lead ${leadWorking ? "working" : "idle"}${requests.length > 0 ? `; ${requests.length} request(s) wait for a person` : ""}`;
      if (line !== lastLine) log(line);
      lastLine = line;
      if (done) {
        doneSince ??= Date.now();
        if (Date.now() - doneSince >= SETTLE_MS) {
          doneBy = "finished";
          wallMs = doneSince - started;
          break;
        }
      } else {
        doneSince = undefined;
      }
      const quiet = !done && !leadWorking && active === 0 && open === 0;
      if (quiet) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= STALL_MS) {
          doneBy = "stalled";
          wallMs = quietSince - started;
          break;
        }
      } else {
        quietSince = undefined;
      }
    }
    log(`fleetd ${doneBy} after ${(wallMs / 60_000).toFixed(1)} min`);

    // What the run did: agents, PRs, the chat, and the time inspector's breakdown for the project and each order.
    const tasks = (await ok("tasks_list", { projectRef, limit: 100 })).tasks as Array<Body>;
    const workstreams = (await ok("workstream_list", { machineId: MACHINE, projectId, limit: 100 })).workstreams as Array<Body>;
    const prs = JSON.parse(gh("pr", "list", "-R", LAB_REPO, "--base", runBranch, "--state", "all", "--limit", "100", "--json", "number,state,title,url,createdAt,mergedAt")) as Array<Body>;
    const chat = (await ok("chat_history", { projectRef, limit: 100 }, human)).messages as Array<Body>;
    fs.writeFileSync(path.join(runDir, "chat.json"), `${JSON.stringify(chat, null, 2)}\n`);
    const since = info.startedAt;
    const breakdown = async (scope: Body) => {
      const out = await call("time_breakdown", { scope, since });
      return out.isError ? { error: out.body } : summarizeTime(out.body);
    };
    const time = {
      project: await breakdown({ kind: "project", projectRef }),
      lead: await breakdown({ kind: "lead", projectRef }),
      orders: await Promise.all(workstreams.map(async (w) => ({ workstreamId: w.workstreamId, state: w.state, ...(await breakdown({ kind: "order", workstreamId: w.workstreamId })) }))),
    };
    const byKind: Record<string, number> = {};
    for (const t of tasks) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
    const asked = fs.existsSync(shimLog) ? fs.readFileSync(shimLog, "utf8").trim().split("\n").filter(Boolean) : [];
    const askedCounts: Record<string, number> = {};
    for (const l of asked) {
      const k = l.split(" ").slice(1).join(" ");
      askedCounts[k] = (askedCounts[k] ?? 0) + 1;
    }

    // Stop what this run started, by the PIDs captured at spawn; then the usage, and the merged result.
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await h.stopAll();
    for (const home of fs.readdirSync(h.RUN).filter((e) => e.startsWith("home-"))) info.usageDirs.push(path.join(h.RUN, home, ".claude/projects"));
    h.cleanupMachineHomes();
    const result = path.join(runDir, "result");
    cloneBranch(runBranch, result);
    return {
      info,
      agents: tasks.length + 1,
      outcome: {
        wallMs,
        doneBy,
        humanFree: doneBy === "finished",
        resultTree: result,
        extra: {
          runBranch,
          maxAgents: opts.maxAgents,
          tasks: { total: tasks.length, byKind, models: [...new Set(tasks.map((t) => `${t.model} ${t.effort ?? ""}`.trim()))] },
          workstreams: workstreams.map((w) => ({ id: w.workstreamId, state: w.state })),
          prs,
          // The model and effort each print-mode claude call asked for before the shim pinned it.
          askedBeforePin: askedCounts,
          time,
        },
      },
    };
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    await h.stopAll();
    h.cleanupMachineHomes();
    lease.release();
  }
}

/** The time inspector's breakdown, cut to what a reader compares: wall, agent time, categories, critical path. */
const summarizeTime = (b: Body) => {
  const kinds = (cat: Body) => Object.fromEntries(((cat.kinds ?? []) as Array<Body>).map((k) => [k.kind, k.ms]));
  return {
    wallMs: b.wallMs,
    agentMs: b.agentMs,
    byCategory: Object.fromEntries(((b.byCategory ?? []) as Array<Body>).map((c) => [c.cat, { ms: c.ms, kinds: kinds(c) }])),
    criticalPath: b.criticalPath
      ? { ms: b.criticalPath.endMs - b.criticalPath.startMs, totals: Object.fromEntries(((b.criticalPath.totals ?? []) as Array<Body>).map((c) => [c.cat, { ms: c.ms, kinds: kinds(c) }])) }
      : undefined,
    topCommands: ((b.topCommands ?? []) as Array<Body>).slice(0, 8).map((c) => ({ label: String(c.label).slice(0, 120), n: c.n, totalMs: c.totalMs })),
    ciChecks: b.ciChecks,
    humanWait: b.humanWait,
    coverage: { complete: b.coverage?.complete, gaps: (b.coverage?.gaps ?? []).length },
  };
};

/**
 * The slot's GitHub lease, as the lab's m7 scenario takes it: the branch `lease/slot/<n>` on a commit that says until
 * when. Creating a branch is atomic, so two runs on one slot (another worktree, another machine) can't both hold it.
 */
const leaseSlot = (slot: number) => {
  const ref = `heads/lease/slot/${slot}`;
  const tree = gh("api", `repos/${LAB_REPO}/commits/seed`, "--jq", ".commit.tree.sha");
  const until = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
  const sha = gh("api", "-X", "POST", `repos/${LAB_REPO}/git/commits`, "-f", `message=lab lease slot/${slot} run bench-${randomUUID()} until ${until}`, "-f", `tree=${tree}`, "--jq", ".sha");
  const created = spawnSync("gh", ["api", "-X", "POST", `repos/${LAB_REPO}/git/refs`, "-f", `ref=refs/${ref}`, "-f", `sha=${sha}`, "--silent"], { encoding: "utf8" });
  if (created.status !== 0) throw new Error(`slot ${slot} is leased by another run (${created.stderr.trim()}); pick another --slot`);
  return {
    release: () => {
      const held = spawnSync("gh", ["api", `repos/${LAB_REPO}/git/ref/${ref}`, "--jq", ".object.sha"], { encoding: "utf8" });
      if (held.status === 0 && held.stdout.trim() === sha) spawnSync("gh", ["api", "-X", "DELETE", `repos/${LAB_REPO}/git/refs/${ref}`]);
    },
  };
};
