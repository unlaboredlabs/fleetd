// A browser takeover's hand-back, timed step by step: the hub's real browser tools on a throwaway home, the node's
// real broker with a real headless Chrome, and the link between them in memory. A person takes the page over, hands
// it back, and an agent's driver sends its next command through the node's proxy. Prints each step's time from the
// hand-back click. `bun bench/handback.ts [rounds]`; needs Playwright's Chrome (~/.cache/ms-playwright).
import { homedir } from "node:os";
import { join } from "node:path";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { get } from "../src/hub/browser/store.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { steerTasks } from "../src/hub/steer/index.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { findChrome, launch } from "../src/node/browser/chrome.ts";
import { Broker, start } from "../src/node/browser/index.ts";
import type { Task } from "../src/shared/contracts.ts";
import { tempHome } from "../test/helpers.ts";
import { testNode } from "../test/node_helpers.ts";
import { addMachine, addProject, agent, caller, testHub } from "../test/screens_helpers.ts";

const rounds = Number(process.argv[2] ?? 5);
const chrome = findChrome(join(homedir(), ".cache", "ms-playwright"));
if (!chrome) throw new Error("no Chrome under ~/.cache/ms-playwright");

const hub = testHub();
startBrowser(hub.hub);
startRoles(hub.hub);
addMachine(hub.hub, "devbox");
addProject(hub.hub, "devbox", "p1");
hub.link.link("devbox", ["browser", "session_end", "screen_settings"]);
// The task asked for the person and ended its turn, as T3842 did; its messages are timed where they reach the agent.
const task = TaskRecords.create(hub.hub.db.conn, {
  taskId: "T0",
  projectRef: { machineId: "devbox", projectId: "p1" },
  workstreamId: "W1",
  title: "sign in",
  kind: "read",
  prompt: "sign in",
  state: "done",
  attempt: 1,
  createdAt: "2026-11-08T11:00:00.000Z",
  endedAt: "2026-11-08T12:00:00.000Z",
} as Task).taskId;
const told: number[] = [];
const seam = steerTasks(hub.hub);
seam.message = async () => {
  told.push(performance.now());
};

const node = testNode();
const profiles = tempHome();
const broker = start(node.node, new Broker(node.node, () => launch(chrome, join(profiles.dir, "profiles"), true)));
// Node to hub: its lead calls, as the task's; hub to node: each frame the hub sends.
const reports: { at: number; control: unknown }[] = [];
node.link.answer = async (op, args) => {
  if (op === "browser_session") reports.push({ at: performance.now(), control: args.control });
  const out = await hub.calls.call(agent("devbox", "p1", task), { op, ...args });
  if (out.error) throw Object.assign(new Error(out.error.message), { code: out.error.code });
  return out.result as Record<string, unknown>;
};
const send = hub.link.send.bind(hub.link);
let reached = 0;
hub.link.send = (machine: string, frame: never) => {
  const ok = send(machine, frame);
  if (ok && (frame as { t: string }).t === "browser_control") reached = performance.now();
  if (ok) queueMicrotask(() => node.link.deliver(frame));
  return ok;
};

const started = (await node.local.call("session_start", { purpose: "hand-back bench" }, "t1")) as { sessionId: string; cdp: string };
const id = started.sessionId;
const ws = new WebSocket(started.cdp);
const answers = new Map<number, (m: unknown) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number };
  if (m.id !== undefined) answers.get(m.id)?.(m);
};
await new Promise((r) => (ws.onopen = r));
let next = 1;
const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
    const n = next++;
    answers.set(n, resolve as never);
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const targets = await cdp("Target.getTargets");
const page = (targets.result!.targetInfos as { targetId: string; type: string }[]).find((t) => t.type === "page")!;
const s = (await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result!.sessionId as string;
await cdp("Page.navigate", { url: "data:text/html,<h1>hand back</h1>" }, s);

const person = caller("operate", { kind: "human", name: "laptop" });
const ms = (from: number, to: number) => (to - from).toFixed(1).padStart(7);
console.log("round  control call  node acted  hub answered  agent told  next command accepted  control agent");
for (let round = 1; round <= rounds; round++) {
  await hub.tools.call(hub.hub, person, "browser_control", { sessionId: id, control: "human" });
  told.length = 0;
  reports.length = 0;
  const click = performance.now();
  const out = (await hub.tools.call(hub.hub, person, "browser_control", { sessionId: id, control: "agent" })) as { output?: unknown };
  const answered = performance.now();
  if (!out.output) throw new Error(`hand back refused: ${JSON.stringify(out)}`);
  const acted = reports.find((r) => r.control !== "human")?.at ?? Number.NaN;
  await Bun.sleep(0);
  const sent = performance.now();
  const reply = await cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true }, s);
  const accepted = performance.now();
  if (reply.error) throw new Error(`next command refused: ${reply.error.message}`);
  for (let i = 0; i < 100 && get(hub.hub, id)?.control !== "agent"; i++) await Bun.sleep(1);
  const agentAgain = performance.now();
  console.log(
    `${String(round).padStart(5)}  ${ms(click, reached)}      ${ms(click, acted)}  ${ms(click, answered)}    ${told[0] === undefined ? "  never" : ms(click, told[0])}  ${ms(sent, accepted)}                ${ms(click, agentAgain)}  ${get(hub.hub, id)?.control}`,
  );
}
ws.close();
await node.local.call("session_end", {}, "t1");
await broker.shutdown();
node.done();
profiles.done();
hub.done();
process.exit(0);
