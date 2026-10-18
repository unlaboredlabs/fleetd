// expired-login: a machine whose fleetd claude has no login (empty CLAUDE_CONFIG_DIR, blank claude.env, so no
// gateway variables either). claude refuses before any API call ("Not logged in · Please run /login"). The node must
// classify the failure Auth and mark its runner logged out, the hub must refuse new launches there, and the doctor's
// claude_login check must fail with the login fix. If the node's start probe already sees the missing login, the
// first launch is refused outright, which is the same outcome one step earlier.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Body, type Lab, MODEL, seedRepo, sessionText } from "../harness.ts";
import { runEnd } from "./kit.ts";

const MACHINE = "lab-nologin";

export async function expiredLogin(lab: Lab) {
  const { check, ok, log, callTool } = lab;
  const repo = path.join(lab.dir, "repo");
  seedRepo(repo, MACHINE);
  lab.joinNode(MACHINE, { login: false });
  try {
    await lab.until(`${MACHINE} linked`, 120_000, async () => {
      const s = (await callTool("fleetd_status")).body;
      if (s.machines.some((m: Body) => m.machineId === MACHINE && m.status !== "offline")) return true;
      await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
      return undefined;
    });
    const projectId = await lab.addProject(MACHINE, repo, "nologin");

    const tryLaunch = () =>
      callTool("thread_launch", {
        machineId: MACHINE,
        projectId,
        prompt: "Reply with the single word OK and nothing else.",
        model: MODEL,
        effort: "low",
        title: "fleetd lab expired-login",
        clientRequestId: randomUUID(),
      });
    const from = await lab.cursor();
    const first = await tryLaunch();
    if (first.isError) {
      log(`the start probe already caught it; first launch refused: ${JSON.stringify(first.body)}`);
    } else {
      const threadId = first.body.threadId as string;
      const { event } = await runEnd(lab, MACHINE, threadId, from, 120_000);
      check(event.type === "thread.failed", `the run ended ${event.type}: ${event.summary}`);
      const actions = (await callTool("actions_list", { machineId: MACHINE, threadId, failedOnly: true })).body.actions as Array<Body>;
      const said = `${event.summary} ${actions.map((a) => a.summary).join(" ")}`;
      check(/Not logged in|\/login|authenticat/iu.test(said), `the failure keeps claude's own words: ${said}`);
      ok(`thread.failed: "${event.summary}"`);
      // No model call: claude's result for the run reports no tokens and no cost.
      const results = sessionText(MACHINE, threadId)
        .split("\n")
        .flatMap((l) => {
          try {
            const line = JSON.parse(l) as Body;
            const msg = (line.msg ?? line) as Body;
            return msg.type === "result" ? [msg] : [];
          } catch {
            return [];
          }
        });
      check(results.length > 0, "the node's transcript has claude's result");
      check(
        results.every((r) => (r.total_cost_usd ?? 0) === 0 && (r.usage?.output_tokens ?? 0) === 0),
        `no model call was made: ${JSON.stringify(results.map((r) => ({ cost: r.total_cost_usd, usage: r.usage })))}`,
      );
      ok("claude refused before any API call (0 tokens, $0)");
    }

    // Now every launch on the machine is refused, until someone logs in there.
    const refused = await lab.until("a launch on the logged-out machine refused", 60_000, async () => {
      const again = await tryLaunch();
      if (again.isError) return again.body;
      log(`launch still accepted (${again.body.threadId}); waiting for the node's login state to reach the hub`);
      await callTool("events_wait", { cursor: await lab.cursor(), machineId: MACHINE, timeoutSec: 5 });
      return undefined;
    });
    check(/login|logged/iu.test(JSON.stringify(refused)), `the refusal names the login: ${JSON.stringify(refused)}`);
    ok(`launch refused: ${JSON.stringify(refused)}`);

    const checks = (await callTool("doctor_list", { rerun: true })).body.checks as Array<Body>;
    const login = checks.find((c) => c.id === `${MACHINE}/claude_login`);
    check(login?.status === "fail", `doctor ${MACHINE}/claude_login fails: ${JSON.stringify(login)}`);
    const fix = `${login!.fix?.label ?? ""} ${login!.fix?.command ?? ""}`;
    check(/claude \/login|setup-token/u.test(fix) && fix.includes("CLAUDE_CONFIG_DIR"), `the fix is the fleetd login command: ${fix}`);
    ok(`doctor ${login!.id}: ${login!.message}; fix: ${fix.trim()}`);
  } finally {
    await lab.stopNode(MACHINE);
  }
}
