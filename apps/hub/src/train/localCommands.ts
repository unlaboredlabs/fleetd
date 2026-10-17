// NodeCommands that run argv on this machine, the way a node answers `cmd_check`: no shell, output tail, exitCode
// null when the command could not start or timed out. For the train's tests (real git in temp repos) and the testbed
// check; the hub itself always goes through the node.
import { execFile } from "node:child_process";
import * as Effect from "effect/Effect";
import { NodeCommands, unlinked } from "../checks/NodeCommands.ts";

const TAIL = 2000;

export const localCommands = (env: NodeJS.ProcessEnv) =>
  NodeCommands.of({
    run: (_machineId, input) =>
      Effect.callback((resume, signal) => {
        const [command = "", ...args] = input.argv;
        execFile(command, args, { cwd: input.cwd, env, signal, timeout: (input.timeoutSec ?? 120) * 1000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.slice(-TAIL);
          if (error === null) return resume(Effect.succeed({ exitCode: 0, outputTail: output, timedOut: false }));
          if (typeof error.code === "number") return resume(Effect.succeed({ exitCode: error.code, outputTail: output, timedOut: false }));
          resume(Effect.succeed({ exitCode: null, outputTail: `could not run ${command}: ${error.message}`.slice(-TAIL), timedOut: error.killed === true }));
        });
      }),
    deliverSecret: unlinked,
    runGated: unlinked,
    attach: () => Effect.void,
    resolve: () => Effect.void,
  });
