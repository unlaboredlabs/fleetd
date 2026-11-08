// A cloud machine's catch-up (crates/fleetd/src/hub/cloud/catch_up.rs): at each of its hellos, before it counts as
// ready for work, the hub delivers it, in order: its build (a node behind the hub's updates and restarts; one on it
// gets the Claude Code it was tested with), what it must forget (cloud_outbox), the hub's Claude configuration
// resealed to it, its worktrees due to go, and its orders' GH_TOKENs again. Only a catch-up whose update and Claude
// steps went through makes it ready: a failed one is tried again a minute later, up to RETRIES times.
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { redeliverOn } from "../github_app/sessions.ts";
import { events } from "../store/events.ts";
import { pool } from "../pool/tools.ts";
import { updates } from "../update/tools.ts";
import { bring, type Brought } from "./claude.ts";
import { pause } from "./every.ts";
import { cloud } from "./index.ts";
import { nodeCan, sessionCall } from "./node.ts";
import { isPool, Outbox } from "./outbox.ts";

const LINK_WAIT_MS = 30_000;
const RETRY_EVERY_MS = 60_000;
export const RETRIES = 3;

export type Report = { restarting: boolean; forgotten: number; claude?: Brought; github: number; problems: string[]; ready: boolean };

/** The tasks area's parts a catch-up uses, when it made them (D355). */
type TasksSide = { sweepWorktreesOn?(m: string): Promise<unknown>; retrySoon?(): void };
const tasksSide = (hub: Hub) => hub.peek<TasksSide>("tasks");

/** Replays what the machine missed, oldest first, dropping each item its node took. */
async function replay(hub: Hub, m: string, report: Report): Promise<void> {
  const outbox = new Outbox(hub.db);
  let items;
  try {
    items = outbox.list(m);
  } catch (e) {
    report.problems.push(`missed forgets not read: ${(e as Error).message}`);
    return;
  }
  for (const [id, item] of items) {
    try {
      if (item.kind === "claude_forget" && nodeCan(hub, m, "claude_accounts")) {
        await sessionCall(hub, m, { op: "claude_account_secret", account: item.account });
      } else if (item.kind === "one_password_forget" && nodeCan(hub, m, "onepassword")) {
        await sessionCall(hub, m, { op: "onepassword_token", personId: item.personId });
      } else {
        throw new Error("its node is too old to take it");
      }
      outbox.done(id);
      report.forgotten++;
    } catch (e) {
      report.problems.push(`${JSON.stringify(item)} not forgotten: ${(e as Error).message}`);
    }
  }
}

/** One catch-up of the cloud machine, for its link live now. Marks it ready unless its node is restarting. */
export async function catchUp(hub: Hub, m: string): Promise<Report> {
  const report: Report = { restarting: false, forgotten: 0, github: 0, problems: [], ready: false };
  const liveSince = executors(hub).liveSince(m);
  if (liveSince === undefined) {
    report.problems.push("its node isn't linked");
    return report;
  }
  let ready = true;
  try {
    if ((await updates(hub).catchUp(m)) === "restarting") {
      report.restarting = true;
      return report;
    }
  } catch (e) {
    ready = false;
    report.problems.push(`not updated: ${(e as Error).message}`);
  }
  await replay(hub, m, report);
  try {
    report.claude = await bring(hub, m);
  } catch (e) {
    ready = false;
    report.problems.push(`Claude not brought: ${(e as Error).message}`);
  }
  await tasksSide(hub)?.sweepWorktreesOn?.(m);
  const { done, problems } = await redeliverOn(hub, m);
  report.github = done;
  report.problems.push(...problems);
  if (ready) {
    cloud(hub).setCaughtUp(m, liveSince);
    cloud(hub).cloning.ensure(hub, pool(hub), m, () => tasksSide(hub)?.retrySoon?.());
    tasksSide(hub)?.retrySoon?.();
  }
  report.ready = ready;
  return report;
}

/** Catches the machine up, and again while a newer link came meanwhile; one at a time per machine. */
async function follow(hub: Hub, running: Set<string>, m: string): Promise<void> {
  if (running.has(m)) return;
  running.add(m);
  try {
    const signal = hub.shutdown.signal;
    await Promise.race([executors(hub).awaitLive(m, signal), pause(LINK_WAIT_MS, signal)]);
    for (let retries = 0; !signal.aborted; ) {
      const live = executors(hub).liveSince(m);
      const report = await catchUp(hub, m);
      const said = JSON.stringify(report);
      if (report.problems.length === 0) console.info(`cloud machine ${m} caught up: ${said}`);
      else if (report.ready) console.warn(`cloud machine ${m} caught up, but not all of it: ${said}`);
      else console.warn(`cloud machine ${m} not caught up: no work goes there yet: ${said}`);
      if (report.restarting) break;
      // A newer link came meanwhile: catch that one up.
      if (executors(hub).liveSince(m) !== live) continue;
      if (report.ready || live === undefined || retries >= RETRIES) break;
      retries++;
      await pause(RETRY_EVERY_MS, signal);
    }
  } finally {
    running.delete(m);
  }
}

/** Catches up each cloud machine as its node links, for the hub's life. */
export async function run(hub: Hub): Promise<void> {
  const running = new Set<string>();
  const log = events(hub);
  let cursor = log.head();
  const signal = hub.shutdown.signal;
  while (!signal.aborted) {
    let page;
    try {
      page = await log.wait({ cursor, types: ["machine.online", "machine.linked"], timeoutSec: 3600 }, signal);
    } catch (e) {
      console.warn("cloud catch-up: machine links not read:", e);
      await pause(1000, signal);
      continue;
    }
    cursor = Math.max(page.cursor, cursor);
    for (const e of page.events) {
      if (e.machineId !== undefined && isPool(hub, e.machineId)) void follow(hub, running, e.machineId).catch((err) => console.error(`cloud catch-up of ${e.machineId}:`, err));
    }
  }
}
