// Status cannot be stale (fleetd.sh/docs/status): a source that goes quiet marks the rows that read it within its
// cadence, and the mark clears when it is back. On the lab repo's train row that m7 leaves, with the hub restarted
// behind a lab-only `gh` that fails while a flag file exists (a dead `gh` is the honest dropped connection):
// 1. baseline: no row is stale, both machines online;
// 2. lab-b's node is killed: its project's row is blocked and stale ("no heartbeat from lab-b") within 45 s of
//    silence + 5 s, and `fleetd status` prints STALE; once it relinks, the row is clean again within 20 s;
// 3. GitHub is cut: source.stale for github:<lab repo> within 180 s + a train pass + 5 s, and the repo's project row
//    says GitHub was not reached; once it is back, source.fresh and a clean row within a minute and 5 s.
// The rows are read again after each event (events_wait), as the app does. No claude turns are asserted.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, fleetdCommand, type Lab, scrubbedEnv } from "./harness.ts";
import { REPO } from "./m7Train.ts";

const MACHINE = "lab-b";
/** The hub's GitHub window and train pass (hub/status/fresh.rs, hub/train). */
const GITHUB_STALE_SEC = 180;
const TRAIN_PASS_SEC = 15;
const MAIN_CI_EVERY_SEC = 60;

export async function statusFresh(lab: Lab) {
  const { callTool, check, ok } = lab;
  const changes = (await callTool("changes_list", { repo: REPO, limit: 1 })).body.changes as Array<Body> | undefined;
  check((changes?.length ?? 0) > 0, `the hub has a train row for ${REPO}; run m7 first (npm run lab -- m7 status)`);
  const repoProject = changes![0]!.projectRef as Body;

  fs.mkdirSync(lab.dir, { recursive: true });
  const shimDir = path.join(lab.dir, "bin");
  const down = path.join(lab.dir, "gh-down");
  const realGh = execFileSync("sh", ["-c", "command -v gh"], { env: scrubbedEnv(), encoding: "utf8" }).trim();
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(
    path.join(shimDir, "gh"),
    `#!/bin/sh\nif [ -e '${down}' ]; then echo 'gh: connect: network is unreachable' >&2; exit 1; fi\nexec '${realGh}' "$@"\n`,
    { mode: 0o755 },
  );
  const keyFile = path.join(lab.dir, "key");
  fs.writeFileSync(keyFile, `${lab.key}\n`, { mode: 0o600 });

  const rows = async () => (await callTool("status_get", {})).body.rows as Array<Body>;
  let cursor = 0;
  /** The first rows for which `holds` gives a value, read again after each event, within `ms`. */
  const rowsUntil = <A>(what: string, ms: number, holds: (rows: Array<Body>) => A | undefined) =>
    lab.until(what, ms, async () => {
      const found = holds(await rows());
      if (found !== undefined) return found;
      cursor = (await callTool("events_wait", { cursor, timeoutSec: 10 })).body.cursor as number;
      return undefined;
    });
  const same = (a: Body, b: Body) => a.machineId === b.machineId && a.projectId === b.projectId;
  const rowOf = (all: Array<Body>, ref: Body) => all.find((r) => same(r.projectRef as Body, ref));

  try {
    await lab.startHub({ PATH: `${shimDir}:${process.env.PATH ?? ""}` });
    cursor = await lab.cursor();
    const fleet = (await callTool("fleetd_status")).body;
    const onB = (fleet.projects as Array<Body>).find((p) => p.machineId === MACHINE);
    check(onB !== undefined, `${MACHINE} has a project (m1 leaves one)`);
    const bProject: Body = { machineId: MACHINE, projectId: onB!.projectId };

    // 1. A restarted hub starts every source unknown; the train's first pass and the relinked nodes clear them.
    await rowsUntil("no stale row after the hub restart", 60_000, (all) => (all.length > 0 && all.every((r) => r.stale === undefined) ? all : undefined));
    const machines = (await callTool("fleetd_status")).body.machines as Array<Body>;
    for (const m of lab.machines) {
      const machine = machines.find((x) => x.machineId === m.id);
      check(machine?.status === "online", `${m.id} online: ${JSON.stringify(machine)}`);
    }
    ok("1. baseline: no row stale; lab-a, lab-b online");

    // 2. A crashed node.
    const t0 = Date.now();
    await lab.stopNode(MACHINE, "SIGKILL");
    const flagged = await rowsUntil(`${MACHINE}'s row stale`, 60_000, (all) => {
      const r = rowOf(all, bProject);
      return r?.stale !== undefined ? r : undefined;
    });
    const took = (Date.now() - t0) / 1000;
    check(took <= 50, `${MACHINE}'s row flagged within 50 s of the kill (took ${took.toFixed(1)} s)`);
    const mark = flagged.stale as Body;
    check(flagged.state === "blocked", `the row is blocked: ${JSON.stringify(flagged)}`);
    check((mark.reason as string).startsWith(`no heartbeat from ${MACHINE}`), `the mark names the machine: "${mark.reason}"`);
    check(Date.parse(mark.since as string) <= t0, `stale since at or before the kill: ${mark.since}`);
    const printed = execFileSync(...fleetdCommand(["status", "--hub", lab.hubUrl, "--key-file", keyFile]), {
      env: { ...scrubbedEnv(), HOME: lab.dir, FLEETD_HOME: path.join(lab.dir, "fleetd") },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    check(/STALE since/u.test(printed), `fleetd status prints STALE:\n${printed}`);
    ok(`2. ${MACHINE} killed: its row stale after ${took.toFixed(1)} s ("${mark.reason}"); fleetd status prints STALE`);

    cursor = await lab.cursor();
    lab.startNode(MACHINE);
    const online = await lab.waitEvent("machine.online", 120_000, { cursor, machineId: MACHINE, types: ["machine.online"] });
    const onlineAt = Date.now();
    cursor = online.cursor;
    await rowsUntil(`${MACHINE}'s row clean`, 20_000, (all) => {
      const r = rowOf(all, bProject);
      return r !== undefined && r.stale === undefined ? r : undefined;
    });
    ok(`   ${MACHINE} back (machine.online seq=${online.event.seq}): its row clean ${((Date.now() - onlineAt) / 1000).toFixed(1)} s later`);
    await lab.waitLive(MACHINE);

    // 3. GitHub unreachable from the hub.
    const source = `github:${REPO}`;
    cursor = await lab.cursor();
    const t1 = Date.now();
    fs.writeFileSync(down, "");
    const stale = await lab.waitEvent(`source.stale ${source}`, (GITHUB_STALE_SEC + TRAIN_PASS_SEC + 5) * 1000, {
      cursor,
      types: ["source.stale"],
      match: (e) => e.data?.source === source,
    });
    check(/unreachable/u.test(stale.event.data.reason), `the reason names the failure: "${stale.event.data.reason}"`);
    cursor = stale.cursor;
    const cut = await rowsUntil(`${REPO}'s project row says GitHub went quiet`, 10_000, (all) => {
      const r = rowOf(all, repoProject);
      return /GitHub not reached/u.test(((r?.stale as Body | undefined)?.reason as string | undefined) ?? "") ? r : undefined;
    });
    ok(`3. gh down: source.stale after ${((Date.now() - t1) / 1000).toFixed(1)} s; the row says "${(cut.stale as Body).reason}"`);

    fs.rmSync(down);
    const t2 = Date.now();
    const fresh = await lab.waitEvent(`source.fresh ${source}`, (MAIN_CI_EVERY_SEC + 5) * 1000, {
      cursor: stale.cursor,
      types: ["source.fresh"],
      match: (e) => e.data?.source === source,
    });
    cursor = fresh.cursor;
    await rowsUntil("the row clean", 10_000, (all) => {
      const r = rowOf(all, repoProject);
      return r !== undefined && r.stale === undefined ? r : undefined;
    });
    ok(`   gh back: source.fresh after ${((Date.now() - t2) / 1000).toFixed(1)} s (stale ${(fresh.event.data.staleMs / 1000).toFixed(1)} s); the row clean`);
  } finally {
    fs.rmSync(down, { force: true });
    if (lab.nodePid(MACHINE) === undefined) lab.startNode(MACHINE);
    // The scenarios after this one get the hub as the run started it.
    await lab.startHub();
  }
}
