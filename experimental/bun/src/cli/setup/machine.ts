// `fleetd machine add|remove|set` (crates/fleetd/src/cli/setup/machine.rs).
import { NotImplemented } from "../../shared/errors.ts";
import { machineSetCommand } from "../project.ts";
import { machineUsage } from "../usages.ts";
import { say } from "./shared.ts";

function usage(message: string): number {
  say(`fleetd: ${message}\n\nusage:\n${machineUsage()}`);
  return 2;
}

export async function machineCommand(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case "add":
      throw new NotImplemented("src/cli/setup: fleetd machine add");
    case "remove":
      throw new NotImplemented("src/cli/setup: fleetd machine remove");
    case "set":
      return machineSetCommand(argv.slice(1));
    case undefined:
      return usage("missing machine command");
    default:
      return usage(`unknown machine command '${argv[0]}'`);
  }
}
