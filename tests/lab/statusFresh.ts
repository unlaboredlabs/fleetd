// The status view cannot be stale (fleetd.sh/docs/status): a source that goes quiet is flagged within its cadence and
// clears when it is back. On the testbed's train row that m7 leaves, with the hub restarted on short GitHub windows
// and a lab-only `gh` that fails while a flag file exists (the lab hub has no public URL, so webhooks stay off and a
// dead `gh` is the honest dropped connection):
// 1. baseline: a clean fleet doc, the testbed's main CI fresh, both machines online;
// 2. lab-b's node is killed: machine:lab-b goes stale within 45 s of silence + 5 s, the headline says "Not live" and
//    names it, `fleetd status` prints OFFLINE; once it relinks, the doc is clean again within 20 s;
// 3. GitHub is cut: source.stale for github:<testbed> within 30 + 10 + 5 s, the CI entry is marked and the headline
//    says "Not live"; once it is back, source.fresh and a clean doc within 10 + 5 s.
// The doc is read through status_wait, which blocks until it changes. No claude turns are asserted; the headline's
// one-shots (haiku) may run.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, fleetdCommand, type Lab, scrubbedEnv } from "./harness.ts";
import { REPO } from "./m7Train.ts";

const MACHINE = "lab-b";
const GITHUB_STALE_SEC = 30;
const MAIN_CI_EVERY_SEC = 10;
const FLEET = { kind: "fleet" };

export async function statusFresh(lab: Lab) {
  const { callTool, check, ok } = lab;
  const changes = (await callTool("changes_list", { repo: REPO, limit: 1 })).body.changes as Array<Body> | undefined;
  check((changes?.length ?? 0) > 0, `the hub has a train row for ${REPO}; run m7 first (npm run lab -- m7 status)`);

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

  // The doc as status_wait sends it: the first version past `after`, or the same doc when nothing changed in time.
  let doc: Body = (await callTool("status_get", { scope: FLEET })).body.doc;
  const next = async () => {
    const answer = (await callTool("status_wait", { scope: FLEET, after: doc.version, timeoutSec: 10 })).body;
    if (answer.doc !== undefined) doc = answer.doc;
    return doc;
  };
  /** The first doc for which `ok` holds, within `ms`. */
  const docUntil = (what: string, ms: number, holds: (d: Body) => boolean) =>
    lab.until(what, ms, async () => {
      const d = await next();
      return holds(d) ? d : undefined;
    });
  const staleSources = (d: Body) => (d.stale as Array<Body>).map((s) => s.source as string);
  const ci = (d: Body) => (d.health.ci as Array<Body>).find((c) => c.repo === REPO);
  const machine = (d: Body, id: string) => (d.health.machines as Array<Body>).find((m) => m.machineId === id);
  const notLive = (d: Body) => (d.headline.text as string).startsWith("Not live");

  try {
    await lab.startHub({
      FLEETD_STATUS_GITHUB_STALE_SEC: String(GITHUB_STALE_SEC),
      FLEETD_MAIN_CI_EVERY_SEC: String(MAIN_CI_EVERY_SEC),
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    });
    doc = (await callTool("status_get", { scope: FLEET })).body.doc;

    // 1. A restarted hub starts every source unknown; the train's first pass and the relinked nodes clear them.
    const clean = await docUntil("a clean fleet doc after the hub restart", 60_000, (d) => d.stale.length === 0 && ci(d)?.asOf !== undefined);
    const asOfAge = (Date.parse(clean.now) - Date.parse(ci(clean)!.asOf)) / 1000;
    check(asOfAge <= 15, `${REPO} main CI as of ${asOfAge} s before the doc (≤ 15 s): ${JSON.stringify(ci(clean))}`);
    for (const m of lab.machines) check(machine(clean, m.id)?.status === "online", `${m.id} online: ${JSON.stringify(machine(clean, m.id))}`);
    ok(`1. baseline v${clean.version}: nothing stale; ${REPO} main CI ${ci(clean)!.state} as of ${asOfAge.toFixed(1)} s; lab-a, lab-b online`);

    // 2. A crashed node.
    const t0 = Date.now();
    await lab.stopNode(MACHINE, "SIGKILL");
    const flagged = await docUntil(`machine:${MACHINE} stale`, 60_000, (d) => staleSources(d).includes(`machine:${MACHINE}`));
    const took = (Date.now() - t0) / 1000;
    check(took <= 50, `machine:${MACHINE} flagged within 50 s of the kill (took ${took.toFixed(1)} s)`);
    const offline = machine(flagged, MACHINE)!;
    check(offline.status === "offline", `${MACHINE} offline in health: ${JSON.stringify(offline)}`);
    check(offline.lastSeenAt === undefined || Date.parse(offline.lastSeenAt) <= t0, `${MACHINE} last seen at or before the kill: ${offline.lastSeenAt}`);
    const headline = await docUntil("the headline says Not live and names lab-b", 15_000, (d) => notLive(d) && (d.headline.text as string).includes(MACHINE));
    // HOME in the run dir: the CLI keeps its "since you last looked here" mark under ~/.fleetd/cli.
    const printed = execFileSync(...fleetdCommand(["status", "--hub", lab.hubUrl, "--key-file", keyFile]), {
      env: { ...scrubbedEnv(), HOME: lab.dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    check(/OFFLINE/u.test(printed), `fleetd status prints OFFLINE:\n${printed}`);
    ok(`2. ${MACHINE} killed: stale after ${took.toFixed(1)} s ("${staleReason(flagged, `machine:${MACHINE}`)}"); headline "${headline.headline.text}"; fleetd status prints OFFLINE`);

    let cursor = await lab.cursor();
    lab.startNode(MACHINE);
    const online = await lab.waitEvent("machine.online", 120_000, { cursor, machineId: MACHINE, types: ["machine.online"] });
    const onlineAt = Date.now();
    const back = await docUntil(`machine:${MACHINE} clear and the headline live`, 20_000, (d) => !staleSources(d).includes(`machine:${MACHINE}`) && !notLive(d));
    ok(`   ${MACHINE} back (machine.online seq=${online.event.seq}): doc clean ${((Date.now() - onlineAt) / 1000).toFixed(1)} s later, v${back.version}`);
    await lab.waitLive(MACHINE);

    // 3. GitHub unreachable from the hub.
    const source = `github:${REPO}`;
    cursor = await lab.cursor();
    const t1 = Date.now();
    fs.writeFileSync(down, "");
    const window = (GITHUB_STALE_SEC + MAIN_CI_EVERY_SEC + 5) * 1000;
    const stale = await lab.waitEvent(`source.stale ${source}`, window, {
      cursor,
      types: ["source.stale"],
      match: (e) => e.data?.source === source,
    });
    check(/unreachable/u.test(stale.event.data.reason), `the reason names the failure: "${stale.event.data.reason}"`);
    const cut = await docUntil(`${source} stale in the doc`, Math.max(5_000, window - (Date.now() - t1)), (d) => staleSources(d).includes(source) && ci(d)?.stale !== undefined && notLive(d));
    ok(`3. gh down: source.stale after ${((Date.now() - t1) / 1000).toFixed(1)} s ("${stale.event.data.reason}"); CI entry marked; headline "${cut.headline.text}"`);

    fs.rmSync(down);
    const t2 = Date.now();
    const fresh = await lab.waitEvent(`source.fresh ${source}`, (MAIN_CI_EVERY_SEC + 5) * 1000, {
      cursor: stale.cursor,
      types: ["source.fresh"],
      match: (e) => e.data?.source === source,
    });
    const healed = await docUntil("a clean doc", Math.max(5_000, (MAIN_CI_EVERY_SEC + 5) * 1000 - (Date.now() - t2)), (d) => d.stale.length === 0 && !notLive(d));
    ok(`   gh back: source.fresh after ${((Date.now() - t2) / 1000).toFixed(1)} s (stale ${(fresh.event.data.staleMs / 1000).toFixed(1)} s); doc clean, v${healed.version}`);
  } finally {
    fs.rmSync(down, { force: true });
    if (lab.nodePid(MACHINE) === undefined) lab.startNode(MACHINE);
    // The scenarios after this one get the hub as the run started it.
    await lab.startHub();
  }
}

const staleReason = (d: Body, source: string) => (d.stale as Array<Body>).find((s) => s.source === source)?.reason as string;
