// expired-login: a machine whose fleetd claude has no login (empty CLAUDE_CONFIG_DIR, blank claude.env, so no
// gateway variables either). The node's start probe (`initialize`, no model call) reports it logged out, so the
// machine must show degraded with a login reason, every launch there must be refused, and the doctor's
// claude_login check must fail with the fleetd login command. No session may start: no claude session file and no
// transcript appear on the machine, so no model call was possible.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Body, claudeConfigDir, type Lab, MODEL, nodeHome, seedRepo } from "../harness.ts";

const MACHINE = "lab-nologin";

/** Every file under `dir`, recursively (none if it doesn't exist). */
const filesUnder = (dir: string): Array<string> =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)) : [];

export async function expiredLogin(lab: Lab) {
  const { check, ok, callTool } = lab;
  const repo = path.join(lab.dir, "repo");
  seedRepo(repo, MACHINE);
  lab.joinNode(MACHINE, { login: false });
  try {
    const machine = await lab.until(`${MACHINE} degraded by its runner probe`, 120_000, async () => {
      const s = (await callTool("fleetd_status")).body;
      const m = (s.machines as Array<Body>).find((x) => x.machineId === MACHINE);
      if (m?.status === "degraded") return m;
      await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
      return undefined;
    });
    check(/log/iu.test(JSON.stringify(machine)), `the machine says why: ${JSON.stringify(machine)}`);
    ok(`${MACHINE} degraded: ${JSON.stringify(machine)}`);
    const projectId = await lab.addProject(MACHINE, repo, "nologin");

    const launched = await callTool("thread_launch", {
      machineId: MACHINE,
      projectId,
      prompt: "Reply with the single word OK and nothing else.",
      model: MODEL,
      effort: "low",
      title: "fleetd lab expired-login",
      clientRequestId: randomUUID(),
    });
    check(launched.isError, `a launch on the logged-out machine is refused: ${JSON.stringify(launched.body)}`);
    check(/log/iu.test(JSON.stringify(launched.body)), `the refusal names the login: ${JSON.stringify(launched.body)}`);
    ok(`launch refused: ${JSON.stringify(launched.body)}`);

    const checks = (await callTool("doctor_list", { rerun: true })).body.checks as Array<Body>;
    const login = checks.find((c) => c.id === `${MACHINE}/claude_login`);
    check(login?.status === "fail", `doctor ${MACHINE}/claude_login fails: ${JSON.stringify(login)}`);
    const fix = `${login!.fix?.label ?? ""} ${login!.fix?.command ?? ""}`;
    check(/claude (auth )?\/?login|setup-token/u.test(fix) && fix.includes("CLAUDE_CONFIG_DIR"), `the fix is the fleetd login command: ${fix}`);
    ok(`doctor ${login!.id}: ${login!.message}; fix: ${fix.trim()}`);

    // claude files a session on its first user message, and the node keeps a transcript per session it ran.
    const sessions = filesUnder(path.join(claudeConfigDir(MACHINE), "projects")).filter((f) => f.endsWith(".jsonl"));
    const transcripts = filesUnder(path.join(nodeHome(MACHINE), "transcripts"));
    check(sessions.length === 0 && transcripts.length === 0, `no session ever started: ${JSON.stringify({ sessions, transcripts })}`);
    ok("no claude session started on the machine, so no model call");
  } finally {
    await lab.stopNode(MACHINE);
  }
}
