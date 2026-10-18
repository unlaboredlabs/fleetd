// M2 lab scenario 4, "degraded machine": lab-b's node loses its agent runtime (restarted, by its recorded PID, with no
// `claude` on its PATH). The hub reports it degraded with the runner's problem and refuses launches there. Restarted
// with claude back on its PATH, the machine comes back online with a live session link. No claude turns.
import { randomUUID } from "node:crypto";
import { type Body, type Lab, MODEL, pathWithoutClaude } from "./harness.ts";

const MACHINE = "lab-b";

export async function degradedMachine(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const machine = async () => ((await callTool("fleetd_status")).body.machines as Array<Body>).find((m) => m.machineId === MACHINE)!;
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  check((await machine()).status === "online", `${MACHINE} is online before its claude goes missing`);
  let cursor = await lab.cursor();

  await lab.stopNode(MACHINE);
  const brokenAt = Date.now();
  lab.startNode(MACHINE, { path: pathWithoutClaude() });
  const degraded = await lab.waitEvent("machine.degraded", 60_000, { cursor, machineId: MACHINE, types: ["machine.degraded"] });
  cursor = degraded.cursor;
  const status = await machine();
  check(status.status === "degraded" && typeof status.degradedReason === "string", `fleetd_status shows why: ${JSON.stringify(status)}`);
  ok(`machine.degraded seq=${degraded.event.seq} ${((Date.now() - brokenAt) / 1000).toFixed(1)} s after the node restarted without claude: "${degraded.event.summary}"`);
  ok(`fleetd_status ${MACHINE}: status=${status.status} degradedReason="${status.degradedReason}"`);

  const launch = await callTool("thread_launch", {
    machineId: MACHINE,
    projectId,
    prompt: "Reply OK.",
    model: MODEL,
    effort: "low",
    clientRequestId: randomUUID(),
  });
  check(launch.isError, `a launch on the degraded machine is refused: ${JSON.stringify(launch.body)}`);
  ok(`thread_launch on ${MACHINE} refused: ${launch.body.code} "${launch.body.message}"`);

  await lab.stopNode(MACHINE);
  lab.startNode(MACHINE);
  const online = await lab.waitEvent("machine.online", 120_000, { cursor, machineId: MACHINE, types: ["machine.online"] });
  await lab.waitLive(MACHINE);
  const after = await machine();
  check(after.status === "online" && after.degradedReason === undefined, `${MACHINE} online without a reason: ${JSON.stringify(after)}`);
  ok(`machine.online seq=${online.event.seq} once claude was back on the node's PATH; project_get is live again`);
}
