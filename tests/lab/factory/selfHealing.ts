// W9 part 6 on a project that isn't fleetd, the part on main so far (#405): a writer commits and pushes its branch,
// then, while it still runs, its worktree and local branch are deleted and its node is killed. When the lead messages
// it, the node rebuilds the worktree at the same path from origin/<branch>, freshly fetched, and the agent's message
// starts with a note saying so. The person's checkout is byte for byte as they left it.
// TODO(W9 self-healing lab): #426 and PR5: the task resumes by itself after the kill (no message from the lead), and
// the lead's next wake says "resumed automatically (attempt 2 of 4)"; a SIGTERM'd node; a session that dies twice on
// the same command escalates once.
import fs from "node:fs";
import { check, ok, sleep } from "../harness.ts";
import type { Factory } from "./kit.ts";
import { git } from "./project.ts";

export async function selfHealing(f: Factory) {
  const { project } = f;
  const human = f.humanCheckout();
  const w = f.workstream("Stock report.");
  // The stand-in runs each `lab-run:` line as a Bash call: commit and push the report, then keep working.
  const spawned = f.spawnWriter(
    w,
    "stock report",
    [
      "Write the stock report, commit and push it, then keep checking stock.",
      "lab-run: printf 'apples: 3\\n' > REPORT.md && git add REPORT.md && git commit -q -m 'report: stock levels' && git push -q origin HEAD",
      "lab-run: sleep 600",
    ].join("\n"),
  );
  const taskId = spawned.taskId as string;
  const running = await f.waitTask(taskId, ["running"]);
  const threadId = running.threadRef.threadId as string;
  const branch = running.branch as string;
  // The node's session record names the worktree from its launch; the task gets it when the hub reads the changes.
  const wt = await f.until(`${taskId}'s worktree`, 30_000, async () => (f.sessionSummary(threadId)?.worktreePath as string | undefined) ?? (await sleep(250), undefined));
  const pushed = await f.until(`${branch} pushed to origin`, 60_000, async () => {
    const sha = git(project.bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
    return sha === "" ? (await sleep(250), undefined) : sha;
  });
  ok(`${taskId} pushed ${branch} at ${pushed.slice(0, 7)} and is still running`);

  // Lost under it: the worktree's directory and the local branch, as a cleanup or a person might; then the node dies.
  git(project.root, "worktree", "remove", "--force", wt);
  git(project.root, "branch", "-q", "-D", branch);
  check(!fs.existsSync(wt), `${wt} is gone`);
  const beforeKill = await f.cursor();
  await f.killNode();
  await f.startNode();
  // The restarted node ends the cut run (and reaps its processes) before anything is sent to it.
  const cut = await f.waitEvent(`${taskId}'s cut run ends`, 60_000, {
    cursor: beforeKill,
    types: ["thread.completed", "thread.failed", "thread.interrupted"],
    match: (e) => e.threadId === threadId,
  });
  ok(`worktree and local branch deleted, node SIGKILLed and restarted: ${cut.event.type} "${cut.event.summary}"; ${taskId} is ${(await f.task(taskId)).state}`);

  // The lead messages it, as it would by hand today: the session resumes in a worktree rebuilt from the pushed branch.
  const from = await f.cursor();
  const sent = f.lead("message_agent", { taskId, message: "Carry on.\nlab-run: git log -1 --format=%H && cat REPORT.md" });
  check(sent.code === 0, `message_agent: ${sent.text}`);
  await f.waitEvent(`${taskId}'s resumed turn ends`, 120_000, {
    cursor: from,
    types: ["thread.completed", "thread.failed", "thread.interrupted"],
    match: (e) => e.threadId === threadId,
  });
  check(fs.existsSync(wt), `the worktree is back at the same path ${wt}`);
  check(git(wt, "rev-parse", "HEAD") === pushed, `it is at the pushed ${pushed.slice(0, 7)}`);
  check(fs.readFileSync(`${wt}/REPORT.md`, "utf8") === "apples: 3\n", "the pushed report is in it");
  check(git(project.root, "rev-parse", `refs/heads/${branch}`) === pushed, `the local ${branch} is back at the pushed commit`);
  const note = f.messages(threadId).at(-1) ?? "";
  check(note.startsWith("fleetd: your worktree and its local branch were gone") && note.includes(`from origin/${branch}`), `the agent was told where its worktree came from:\n${note}`);
  check(f.sessionSummary(threadId)?.recreatedFrom === "remote", `the session says recreatedFrom remote: ${JSON.stringify(f.sessionSummary(threadId))}`);
  ok(`rebuilt from origin/${branch} at ${pushed.slice(0, 7)}; the agent's message began: "${note.split("\n")[0]!.slice(0, 90)}…"`);
  human.unchanged("after the rebuild");
}
