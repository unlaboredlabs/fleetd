// `fleetd update [--check] [--channel <c>] [--now]` and `fleetd update-claude` (crates/fleetd/src/cli/update.rs): the
// flags here, the update itself in src/update, which T2256 ports (feed, plan, finish, services).
import { NotImplemented } from "../shared/errors.ts";
import { ArgError, parse } from "./args.ts";
import { usageText } from "./index.ts";

export async function updateCommand(argv: string[]): Promise<number> {
  const v = parse(argv, { options: { check: "bool", channel: "str", now: "bool" }, positionals: false });
  if (v instanceof ArgError) {
    process.stderr.write(`fleetd: ${v.message}\n\n${usageText()}`);
    return 2;
  }
  throw new NotImplemented("src/update: fleetd update");
}

export async function runClaude(): Promise<number> {
  throw new NotImplemented("src/update: fleetd update-claude");
}
