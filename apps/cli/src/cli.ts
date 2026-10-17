import { PROTOCOL_VERSION } from "@fleetd/contracts";
import pkg from "../package.json" with { type: "json" };
import { HUB_KEY_USAGE, hubKey } from "./hub-key.ts";
import { HUB_TOKEN_USAGE, hubToken } from "./hub-token.ts";
import { NODE_USAGE, nodeCommand } from "./node.ts";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `usage: fleetd <command>

commands:
  version    print the fleetd version and protocol
  help       show this message
${HUB_KEY_USAGE}${HUB_TOKEN_USAGE}${NODE_USAGE}`;

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
      return { code: 2, stdout: "", stderr: `fleetd: unknown hub command '${argv[1] ?? ""}'\n\n${USAGE}` };
    default:
      return { code: 2, stdout: "", stderr: `fleetd: unknown command '${command}'\n\n${USAGE}` };
  }
};

/** Commands that keep running (`node …`); `undefined` when argv is not one of them. */
export const runLongRunning = (argv: readonly string[]): Promise<number> | undefined =>
  argv[0] === "node" ? nodeCommand(argv.slice(1)) : undefined;
