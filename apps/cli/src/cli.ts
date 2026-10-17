import { PROTOCOL_VERSION } from "@fleetd/contracts";
import pkg from "../package.json" with { type: "json" };

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `usage: fleetd <command>

commands:
  version    print the fleetd version and protocol
  help       show this message
`;

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
    default:
      return { code: 2, stdout: "", stderr: `fleetd: unknown command '${command}'\n\n${USAGE}` };
  }
};
