import { HUB_START_USAGE, hubProgram, parseHubArgs } from "@fleetd/hub/main.ts";
import { runUntilSignal } from "./node.ts";

export { HUB_START_USAGE };

/** `fleetd hub start [--home <dir>] [--listen <host:port>]`: runs the hub in the foreground until a signal. */
export const hubStart = (argv: ReadonlyArray<string>): Promise<number> => {
  const options = parseHubArgs(argv);
  if ("error" in options) {
    process.stderr.write(`fleetd: ${options.error}\n\nusage:\n${HUB_START_USAGE}`);
    return Promise.resolve(2);
  }
  return runUntilSignal(hubProgram(options));
};
