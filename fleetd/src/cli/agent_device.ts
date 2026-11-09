// `fleetd agent-device <args>`: what the forwarding `agent-device` runs while
// an agent's iOS screen is on another machine. The command goes to the agent's node, which sends it on through the
// hub; its output and exit code come back as agent-device's own would.
import { sleep } from "./common.ts";
import { nodeCall, why } from "./node_call.ts";

/** A command may send a file first and wait out a runner's start on the screen's machine. */
const WAIT_MS = 600_000;
const STARTING_POLL_MS = 1000;
const RUNNER_STARTING = "fleetd: the screen's XCTest runner is still starting; the command waits for it.\n";

type Answered = [stdout: string, stderr: string, code: number];

export async function run(args: string[]): Promise<number> {
  const call = { op: "device", step: "run", args };
  const started = Date.now();
  let answered: Answered;
  for (;;) {
    answered = answer(await nodeCall(call, WAIT_MS).then((f) => f, (e: unknown) => new Error(why(e))));
    if (!(answered[2] === 75 && answered[1] === RUNNER_STARTING) || Date.now() - started > WAIT_MS) break;
    await sleep(STARTING_POLL_MS);
  }
  process.stdout.write(answered[0]);
  process.stderr.write(answered[1]);
  return answered[2];
}

function answer(frame: Record<string, unknown> | Error): Answered {
  if (frame instanceof Error) return ["", `fleetd: ${frame.message}\n`, 1];
  const result = frame.result as any;
  if (result?.step === "run") {
    const code = typeof result.exitCode === "number" ? result.exitCode : 1;
    return [
      typeof result.stdout === "string" ? result.stdout : "",
      typeof result.stderr === "string" ? result.stderr : "",
      Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1,
    ];
  }
  const error = frame.error as any;
  let text = `fleetd: ${typeof error?.message === "string" ? error.message : "the node sent no answer"}\n`;
  if (typeof error?.fix === "string") text += `fleetd: ${error.fix}\n`;
  return ["", text, 1];
}
