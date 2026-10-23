// Shared pieces of the failure scenarios: lab-b restarts with overrides, finding a session's claude process under its
// node, newest reply text, and installing the lab-only claude shim. Never used in CI.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Body, descendants, type Lab, MECHANICS, type NodeOptions, type ProcInfo, REPO, realClaude, sleep, stillRuns } from "../harness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(REPO, "crates/fleetd/src/node/runner/fixtures");
/** The standing machine the scenarios restart with overrides; lab-a keeps the real defaults throughout. */
export const MACHINE = "lab-b";

export const projectOf = async (lab: Pick<Lab, "callTool" | "check">, machineId: string): Promise<string> => {
  const projects = (await lab.callTool("projects_list", { machineId })).body.projects as Array<Body>;
  const projectId = projects[0]?.projectId as string | undefined;
  lab.check(projectId, `${machineId} has a project: ${JSON.stringify(projects)}`);
  return projectId!;
};

/** Restarts the machine's node with `opts` (or the defaults) by its PID and waits until its link is live again. */
export const restartNode = async (lab: Lab, machineId: string, opts: NodeOptions = {}) => {
  await lab.stopNode(machineId);
  lab.startNode(machineId, opts);
  await lab.waitLive(machineId);
  const extra = [...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`), ...(opts.pathPrefix ?? []).map((d) => `PATH+=${d}`)];
  lab.ok(`${machineId} node restarted${extra.length > 0 ? ` with ${extra.join(" ")}` : " on the defaults"}`);
};

/** Runs `body` with the machine's node restarted under `opts`, and puts the defaults back however it ends. */
export const withNode = async (lab: Lab, machineId: string, opts: NodeOptions, body: () => Promise<void>) => {
  await restartNode(lab, machineId, opts);
  try {
    await body();
  } finally {
    await restartNode(lab, machineId);
  }
};

/** A claude session process: the runner always speaks stream-json on stdin. A shim proxy matches too. */
const isClaude = (p: ProcInfo) => p.cmdline.includes("--input-format") && p.cmdline.includes("stream-json");

/** The live claude process for `threadId` under the node (`--session-id`/`--resume` carry the thread id). */
export const claudeOf = (nodePid: number, threadId: string): ProcInfo | undefined =>
  descendants(nodePid).find((p) => isClaude(p) && p.cmdline.includes(threadId));

/**
 * Waits for a process condition that has no hub event (a child appearing under the node, a reaped one going away).
 * Reads /proc every 250 ms; bounded by `ms`.
 */
export const untilProc = async <A>(lab: Pick<Lab, "until">, what: string, ms: number, probe: () => A | undefined): Promise<A> =>
  lab.until(what, ms, async () => {
    const value = probe();
    if (value === undefined) await sleep(250);
    return value;
  });

/** Kills recorded processes that still run (same pid and start time), so a failed check leaves nothing behind. */
export const killSurvivors = (procs: ReadonlyArray<ProcInfo>) => {
  const live = procs.filter(stillRuns);
  for (const p of live) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // Gone between the check and the kill.
    }
  }
  return live;
};

/** Launches a thread with `prompt` on the tiny model and returns its id. */
export const launch = async (lab: Pick<Lab, "callTool" | "check">, machineId: string, projectId: string, title: string, prompt: string) => {
  const launched = await lab.callTool("thread_launch", { machineId, projectId, prompt, ...MECHANICS, title, clientRequestId: randomUUID() });
  lab.check(!launched.isError, `thread_launch on ${machineId}: ${JSON.stringify(launched.body)}`);
  return launched.body.threadId as string;
};

export const send = async (lab: Pick<Lab, "callTool" | "check">, machineId: string, threadId: string, message: string) => {
  const sent = await lab.callTool("thread_send", { machineId, threadId, message, clientRequestId: randomUUID() });
  // queued: true here means claude queued it behind a run already going, which is fine.
  lab.check(!sent.isError && sent.body.queuedUntil === undefined, `thread_send to ${threadId}: ${JSON.stringify(sent.body)}`);
};

/** The first run-ending event for the thread after `cursor` (thread.started and node retries' interim states skipped). */
export const runEnd = (lab: Lab, machineId: string, threadId: string, cursor: number, ms: number, types?: ReadonlyArray<string>) =>
  lab.waitEvent(`a run of ${threadId} to end`, ms, {
    cursor,
    machineId,
    match: (e) =>
      e.threadId === threadId &&
      (types ?? ["thread.completed", "thread.failed", "thread.interrupted", "thread.usage_limited", "thread.waiting"]).includes(e.type),
  });

/**
 * Waits for a completed run whose newest reply passes `test`. Earlier completions are skipped; a failed run ends the
 * wait.
 */
export const replyAfter = async (lab: Lab, machineId: string, threadId: string, cursor: number, ms: number, test: (reply: string) => boolean) => {
  const deadline = Date.now() + ms;
  let from = cursor;
  for (;;) {
    const { event } = await runEnd(lab, machineId, threadId, from, Math.max(deadline - Date.now(), 1_000), ["thread.completed", "thread.failed"]);
    lab.check(event.type === "thread.completed", `the run ended ${event.type}: ${event.summary}`);
    const { reply, items } = await newestReply(lab, machineId, threadId);
    if (reply !== undefined && test(reply)) return reply;
    lab.check(Date.now() < deadline, `no matching reply in time; newest messages: ${JSON.stringify(items)}`);
    lab.log(`run completed with "${reply}"; waiting for the next one`);
    from = event.seq as number;
  }
};

export const newestReply = async (lab: Pick<Lab, "callTool">, machineId: string, threadId: string) => {
  const items = (await lab.callTool("thread_tail", { machineId, threadId, n: 6, kinds: ["message"] })).body.items as Array<Body>;
  return { reply: items.find((i) => i.role === "assistant")?.text as string | undefined, items };
};

/** A lab-only `claude` first on a node's PATH. See claudeShim.ts. */
export interface Shim {
  /** Put this first on the node's PATH. */
  readonly dir: string;
  /** How many user messages the shim answered from the fixture so far. */
  readonly replays: () => number;
}

/**
 * Writes `<dir>/claude`: stream-json sessions go through claudeShim.ts, which answers the first `replays` user
 * messages from `fixture` and hands everything else to the real claude; any other invocation (`--version`) is the
 * real claude. The node builds its children's environment from scratch, so the settings are baked into the script.
 */
export const installShim = (dir: string, opts: { readonly fixture: string; readonly replays: number; readonly resetsInSec?: number }): Shim => {
  fs.mkdirSync(dir, { recursive: true });
  const state = path.join(dir, "replays");
  const config = path.join(dir, "config.json");
  fs.writeFileSync(state, "0\n");
  fs.writeFileSync(
    config,
    `${JSON.stringify({ real: realClaude(), fixture: path.join(FIXTURES, opts.fixture), replays: opts.replays, state, resetsInSec: opts.resetsInSec ?? 90 }, null, 2)}\n`,
  );
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  fs.writeFileSync(
    path.join(dir, "claude"),
    `#!/bin/sh\n# Lab-only claude shim (tests/lab/failure); never installed outside a lab run dir.\n` +
      `case " $* " in *" --input-format "*) exec ${q(process.execPath)} ${q(path.join(HERE, "claudeShim.ts"))} ${q(config)} "$@" ;; esac\n` +
      `exec ${q(realClaude())} "$@"\n`,
    { mode: 0o755 },
  );
  return { dir, replays: () => Number(fs.readFileSync(state, "utf8").trim()) };
};
