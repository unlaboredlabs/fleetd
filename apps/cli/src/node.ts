import fs from "node:fs";
import { parseArgs } from "node:util";
import * as FleetdNode from "@fleetd/node";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

export const NODE_USAGE = `  node join --hub <url> (--token <token> | --token-file <file|->) --machine <id> --t3-home <dir>
            --t3-url <url> [--t3-cmd <cmd>] [--t3-restart-cmd <cmd>] [--tags a,b] [--name <name>]
            [--home <dir>] [--enroll-only]
             enroll this machine with the hub, then keep its link up (node home default ~/.fleetd/node);
             --t3-restart-cmd (e.g. "t3 service restart") runs when T3 fails 3 health checks, else T3 is
             only reported down; --token-file - reads the token from stdin; --enroll-only exits once
             the hub has accepted this node
  node run [--home <dir>]
             keep the link up for a machine that has joined
`;

const options = {
  home: { type: "string" },
  hub: { type: "string" },
  token: { type: "string" },
  "token-file": { type: "string" },
  "enroll-only": { type: "boolean" },
  machine: { type: "string" },
  "t3-home": { type: "string" },
  "t3-url": { type: "string" },
  "t3-cmd": { type: "string" },
  "t3-restart-cmd": { type: "string" },
  tags: { type: "string" },
  name: { type: "string" },
} as const;

const usage = (message: string) => {
  process.stderr.write(`fleetd: ${message}\n\nusage:\n${NODE_USAGE}`);
  return 2;
};

/**
 * Runs until SIGINT/SIGTERM (exit 0) or a failure the node cannot retry past (exit 1). A program that ends with a
 * number exits with it.
 */
export const runUntilSignal = async (program: Effect.Effect<unknown, { readonly message: string }>) => {
  const fiber = Effect.runFork(program);
  const stop = () => Effect.runFork(Fiber.interrupt(fiber));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (Exit.isSuccess(exit)) return typeof exit.value === "number" ? exit.value : 0;
  if (Cause.hasInterruptsOnly(exit.cause)) return 0;
  const error = Cause.squash(exit.cause);
  process.stderr.write(`fleetd: ${error instanceof Error || (typeof error === "object" && error !== null && "message" in error) ? (error as { message: string }).message : String(error)}\n`);
  return 1;
};

/** `fleetd node …`. Long-running, so it returns an exit code once the node stops. */
export const nodeCommand = (argv: ReadonlyArray<string>): Promise<number> => {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: [...rest], options }));
  } catch (error) {
    return Promise.resolve(usage(error instanceof Error ? error.message : String(error)));
  }
  switch (command) {
    case "join": {
      const { hub, machine } = values;
      const tokenFile = values["token-file"];
      let token = values.token;
      if (token === undefined && tokenFile !== undefined) {
        try {
          token = fs.readFileSync(tokenFile === "-" ? 0 : tokenFile, "utf8").trim();
        } catch (error) {
          return Promise.resolve(usage(`cannot read --token-file: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      const t3Home = values["t3-home"];
      const t3Url = values["t3-url"];
      const missing = Object.entries({ hub, token, machine, "t3-home": t3Home, "t3-url": t3Url }).find(([, v]) => !v)?.[0];
      if (missing !== undefined || !hub || !token || !machine || !t3Home || !t3Url) {
        return Promise.resolve(usage(`--${missing} is required`));
      }
      return runUntilSignal(
        FleetdNode.join({
          hub,
          token,
          machine,
          t3Home,
          t3Url,
          ...(values["t3-cmd"] === undefined ? {} : { t3Cmd: values["t3-cmd"] }),
          ...(values["t3-restart-cmd"] === undefined ? {} : { t3RestartCmd: values["t3-restart-cmd"] }),
          ...(values.tags === undefined ? {} : { tags: values.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }),
          ...(values.name === undefined ? {} : { name: values.name }),
          ...(values.home === undefined ? {} : { home: values.home }),
          ...(values["enroll-only"] === true ? { exitWhenEnrolled: true } : {}),
        }),
      );
    }
    case "run":
      return runUntilSignal(FleetdNode.start(values.home === undefined ? {} : { home: values.home }));
    default:
      return Promise.resolve(usage(command ? `unknown node command '${command}'` : "missing node command"));
  }
};
