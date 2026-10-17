import { PROTOCOL_VERSION } from "@fleetd/contracts";
import pkg from "../package.json" with { type: "json" };
import { HUB_KEY_USAGE, hubKey } from "./hub-key.ts";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `usage: fleetd <command>

commands:
  version    print the fleetd version and protocol
  help       show this message
${HUB_KEY_USAGE}`;

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
      return { code: 2, stdout: "", stderr: `fleetd: unknown hub command '${argv[1] ?? ""}'\n\n${USAGE}` };
    default:
      return { code: 2, stdout: "", stderr: `fleetd: unknown command '${command}'\n\n${USAGE}` };
  }
};
