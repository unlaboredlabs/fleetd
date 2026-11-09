// Seeds agent messages (agent_message) into a factory lab fleet, for the apps' DM views: real agents of the lab's
// project write to each other from inside their own sessions, so every message, its recipients' outcomes and its events
// are the hub's own. The claude stand-in runs each `lab-run:` line of a task's prompt as a Bash call in the task's
// session, so the agent-mcp call it makes is that task's, as a real agent's is; nothing here writes the database.
//
//   import { agentMessageLine, seedAgentMessages } from "./factory/agentMessages.ts";
//   await seedAgentMessages(f);     // in a withFactory body: three agents, four messages, every outcome
//   f.spawnWriter(w, "title", `${agentMessageLine(["T3"], "my PR is #42")}\n`)   // one of your own
import { type Body, check, ok } from "../harness.ts";
import type { Factory } from "./kit.ts";

const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** A `lab-run:` line: the agent whose prompt holds it calls `name` with `args`, as itself. */
export function agentToolLine(name: string, args: Record<string, unknown>): string {
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  // As leadWake.ts's writer asks: the session's own fleetd, which names the call by the session its shell runs in.
  return `lab-run: printf '%s\\n' ${quoted(call)} | fleetd agent-mcp --role worker`;
}

/** A `lab-run:` line that sends `text` to `to` (task ids) with agent_message, from the agent whose prompt holds it. */
export const agentMessageLine = (to: ReadonlyArray<string>, text: string) => agentToolLine("agent_message", { to, text });

/**
 * Three agents under one order, and four messages between them with every outcome: delivered (to a running agent),
 * refused (to an id the project has none of), not_woken (to one that finished), woke (an answer to one that asked) and
 * one to two agents at once. Returns the agents' ids.
 */
export async function seedAgentMessages(f: Factory): Promise<{ readonly taskIds: ReadonlyArray<string> }> {
  const w = f.workstream("Retry failed uploads.");
  const id = (t: Body) => t.taskId as string;
  // The limiter's writer stays busy for a while, so the others reach it running.
  const limiter = id(f.spawnWriter(w, "Rate-limit the upload API", "lab-run: sleep 25\nlab-run: sleep 5\n"));
  await f.waitTask(limiter, ["running"]);
  const errors = id(
    f.spawnWriter(
      w,
      "Show upload errors in the app",
      [
        agentMessageLine([limiter], "My PR #42 renames upload_limit to upload_quota in api/limits.rs; rebase on it once it merges."),
        agentMessageLine([limiter, "T999"], "I show 429 as 'Too many uploads, try again in a minute'. Tell me if the header changes."),
        agentToolLine("ask_lead", { question: "Should the error say how long to wait, from Retry-After?" }),
      ].join("\n"),
    ),
  );
  await f.waitTask(errors, ["done"], 60_000);
  await f.waitTask(limiter, ["done"], 60_000);
  const retry = id(
    f.spawnWriter(
      w,
      "Retry failed uploads",
      [
        agentMessageLine([limiter], "Your limiter answers 429 with Retry-After; I retry on that, at most 3 times."),
        agentMessageLine([errors], "Yes: Retry-After is in seconds, and api/limits.rs sets it on every 429."),
      ].join("\n"),
    ),
  );
  await f.waitTask(retry, ["done"], 60_000);
  await f.waitTask(errors, ["done"], 60_000);
  ok(`agent messages seeded between ${limiter}, ${errors} and ${retry}`);
  return { taskIds: [limiter, errors, retry] };
}

/** `npm run factory -- agent-messages`: the seed, then what the person reads of it with agent_messages. */
export async function agentMessages(f: Factory) {
  const { taskIds } = await seedAgentMessages(f);
  const [limiter, errors] = taskIds as [string, string, string];
  const read = await f.callTool("agent_messages", { projectRef: f.ref });
  check(!read.isError, `agent_messages: ${JSON.stringify(read.body)}`);
  const messages = read.body.messages as Array<Body>;
  const outcomes = messages
    .slice()
    .reverse()
    .map((m) => (m.to as Array<Body>).map((t) => `${t.taskId}:${t.outcome}`).join(" "));
  // The first two reached the limiter running (T999 is no agent); the third found it finished, and the fourth answered
  // what the errors agent asked.
  const want = [`${limiter}:delivered`, `${limiter}:delivered T999:refused`, `${limiter}:not_woken`, `${errors}:woke`];
  check(JSON.stringify(outcomes) === JSON.stringify(want), `outcomes ${JSON.stringify(outcomes)}, want ${JSON.stringify(want)}`);
  const limiterThread = ((await f.task(limiter)).threadRef as Body).threadId as string;
  check(
    f.messages(limiterThread).some((m) => m.includes("writes to you") && m.includes("upload_quota")),
    `${limiter} was given the first message: ${JSON.stringify(f.messages(limiterThread))}`,
  );
  ok(`agent_messages reads ${messages.length} messages, every outcome as sent`);
}
