// `fleetd revyl <args>`: what the `revyl` on an agent session's PATH runs. The command goes to the session's node,
// which runs Revyl's own CLI on the session's Revyl screen with the team's key (node/revyl); its output and exit code
// come back as revyl's own would. The key never reaches the session.
import { nodeCall, why } from "./node_call.ts";

/** A build upload may take a while. */
const WAIT_MS = 11 * 60_000;

const HELP = `revyl: your Revyl screen (fleetd). session_start kind ios or android gives you one when the team routes phone
screens to Revyl. Drive it by coordinates, after a screenshot:
  revyl device screenshot --out shot.png
  revyl device tap --x 120 --y 300        (iOS in points, Android in pixels)
  revyl device swipe up | long-press --x --y | type --x --y --text "hi" | key --key ENTER
  revyl device info | hierarchy | logs
  revyl build upload --file <your .app or .apk>, then revyl device install / launch
fleetd starts and ends the device (session_start, session_end). Revyl's AI-driven actions (--target), remote builds,
tests, feedback and billing are off.
`;

export async function run(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  let frame: Record<string, unknown>;
  try {
    frame = await nodeCall({ op: "revyl", argv: args }, WAIT_MS);
  } catch (e) {
    process.stderr.write(`revyl: ${why(e)}\n`);
    return 1;
  }
  const result = frame.result as { exitCode?: unknown; output?: unknown } | undefined;
  if (result && typeof result === "object") {
    const output = typeof result.output === "string" ? result.output : "";
    if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    const code = typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : 1;
    return code >= 0 && code <= 255 ? code : 1;
  }
  const error = frame.error as { message?: unknown; fix?: unknown } | undefined;
  process.stderr.write(`revyl: ${typeof error?.message === "string" ? error.message : "the node sent no answer"}\n`);
  if (typeof error?.fix === "string") process.stderr.write(`revyl: ${error.fix}\n`);
  return 1;
}
