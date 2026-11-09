// `fleetd cloud stop` (crates/fleetd/src/cli/cloud.rs): the cloud machines' kill switch (cloud_stop), the same as
// Settings › Cloud's "Stop all cloud machines".
import { ArgError, parse } from "./args.ts";
import { println, writeErr } from "./common.ts";
import { jsonText } from "./json.ts";
import { hubFlags } from "./status.ts";
import { Exit, Hub } from "./time.ts";
import { CLOUD_USAGE } from "./usages.ts";
export { CLOUD_USAGE };

export function parseCloudArgs(argv: string[]): { hub?: [string, string]; json: boolean } {
  const v = parse(argv, { options: { hub: "str", "key-file": "str", json: "bool" }, positionals: true });
  if (v instanceof ArgError) throw v;
  const p = v.positionals;
  if (p.length === 0) throw new ArgError("cloud needs a command: stop");
  if (!(p.length === 1 && p[0] === "stop")) throw new ArgError(`unknown cloud command '${p[0]}'`);
  const hub = hubFlags(v);
  return { ...(hub ? { hub } : {}), json: v.flag("json") };
}

export async function cloudCommand(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseCloudArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    writeErr(`fleetd: ${error.message}\n\nusage:\n${CLOUD_USAGE}`);
    return 2;
  }
  try {
    const hub = await Hub.connect(args.hub, undefined, "cloud");
    const out = await hub.call("cloud_stop", {});
    if (args.json) println(jsonText(out));
    else for (const line of stopLines(out)) println(line);
    return Array.isArray(out?.failed) && out.failed.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}

export function stopLines(out: any): string[] {
  const list = (k: string): string[] => (Array.isArray(out?.[k]) ? out[k].filter((s: unknown) => typeof s === "string") : []);
  const stopped = list("stopped");
  const lines = [
    stopped.length === 0 ? "Cloud machines are off. None was running." : `Cloud machines are off. Stopped ${stopped.join(", ")}.`,
  ];
  for (const failed of list("failed")) lines.push(`Not stopped: ${failed}. Its lease stops it within 30 minutes.`);
  if (typeof out?.unlisted === "string") {
    lines.push(
      `boat.dev's list couldn't be read (${out.unlisted}): stopped the machines the hub knows; leases stop any other within 30 minutes.`,
    );
  }
  return lines;
}
