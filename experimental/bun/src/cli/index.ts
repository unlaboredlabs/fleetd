// The `fleetd` command line (crates/fleetd/src/cli/mod.rs): one binary, with the hub and the node as subcommands.
import { PROTOCOL_VERSION } from "../shared/contracts.ts";
import { NotImplemented } from "../shared/errors.ts";
import { VERSION } from "../shared/version.ts";
import { hubStart, HUB_START_USAGE } from "../hub/serve/index.ts";
import { nodeCommand } from "../node/index.ts";
import { run as updateFinish } from "../update/finish.ts";

export const versionLine = () => `fleetd ${VERSION} (protocol ${PROTOCOL_VERSION})\n`;

// TODO(cli): the whole usage, as the Rust binary prints it (crates/fleetd/src/cli/mod.rs `usage_text`).
export const usageText = () => `usage: fleetd <command>

commands:
  version    print the fleetd version and protocol
  help       show this message
running by hand:
${HUB_START_USAGE}`;

/** Runs `argv` (without the binary's name) and returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, sub] = argv;
  try {
    switch (command) {
      case "version":
      case "--version":
      case "-v":
        process.stdout.write(versionLine());
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(usageText());
        return 0;
      case "hub":
        if (sub === "start") return await hubStart(argv.slice(2));
        throw new NotImplemented(`src/cli: fleetd hub ${sub ?? ""}`.trim());
      case "node":
        return await nodeCommand(argv.slice(1));
      case "agent-mcp":
        return await (await import("./agent_mcp/index.ts")).agentMcp(argv.slice(1));
      case "update-finish":
        return await updateFinish(argv[1]);
      default:
        throw new NotImplemented(`src/cli: fleetd ${command}`);
    }
  } catch (error) {
    if (!(error instanceof NotImplemented)) throw error;
    process.stderr.write(`fleetd: ${error.message}\n`);
    return 1;
  }
}
