import { PROTOCOL_VERSION } from "@fleetd/contracts";
import pkg from "../package.json" with { type: "json" };
import { HUB_DEVICE_USAGE, hubDevice } from "./hub-device.ts";
import { HUB_KEY_USAGE, hubKey } from "./hub-key.ts";
import { HUB_START_USAGE, hubStart } from "./hub-start.ts";
import { HUB_TOKEN_USAGE, hubToken } from "./hub-token.ts";
import { LEAD_USAGE } from "./lead.ts";
import { LISTEN_USAGE, listenCommand } from "./listen.ts";
import { NODE_USAGE, nodeCommand } from "./node.ts";
import { SETUP_USAGE, setupCommand } from "./setup/init.ts";
import { MACHINE_USAGE, machineCommand } from "./setup/machine.ts";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `usage: fleetd <command>

commands:
  version    print the fleetd version and protocol
  help       show this message

setting up (on the hub machine):
${SETUP_USAGE}${MACHINE_USAGE}
running by hand:
${HUB_START_USAGE}${HUB_KEY_USAGE}${HUB_TOKEN_USAGE}${HUB_DEVICE_USAGE}${NODE_USAGE}${LISTEN_USAGE}
lead-side commands (run by a lead or task inside a project workspace):
${LEAD_USAGE}`;

export const run = (argv: readonly string[]): CliResult => {
  const [command] = argv;
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      return { code: 0, stdout: `fleetd ${pkg.version} (protocol ${PROTOCOL_VERSION})\n`, stderr: "" };
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { code: 0, stdout: USAGE, stderr: "" };
    case "hub":
      if (argv[1] === "key") return hubKey(argv.slice(2));
      if (argv[1] === "token") return hubToken(argv.slice(2));
      if (argv[1] === "device") return hubDevice(argv.slice(2));
      return { code: 2, stdout: "", stderr: `fleetd: unknown hub command '${argv[1] ?? ""}'\n\n${USAGE}` };
    default:
      return { code: 2, stdout: "", stderr: `fleetd: unknown command '${command}'\n\n${USAGE}` };
  }
};

/** Commands that keep running (`node …`, `hub start`, `listen`) or wait on other processes (setup); `undefined` for the rest. */
export const runLongRunning = (argv: readonly string[]): Promise<number> | undefined => {
  if (argv[0] === "init" || argv[0] === "uninstall") return setupCommand(argv[0], argv.slice(1));
  if (argv[0] === "machine") return machineCommand(argv.slice(1));
  if (argv[0] === "node") return nodeCommand(argv.slice(1));
  if (argv[0] === "listen") return listenCommand(argv.slice(1));
  if (argv[0] === "hub" && argv[1] === "start") return hubStart(argv.slice(2));
  return undefined;
};
