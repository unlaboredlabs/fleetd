// `fleetd navi create|list|rename|archive|unarchive`: the old name of `fleetd project
// add --new …`, `project list`, `project set` and `project archive|unarchive`, kept for one release.
import { ArgError, parse, type Parsed } from "./args.ts";
import { isTty, println, resolveHome, s, tilde } from "./common.ts";
import type { McpClient } from "./mcp_client.ts";
import { call, Out, Stop } from "./out.ts";
import { archiveCall } from "./project.ts";
import { connectTo } from "./setup/doctor.ts";
import { isFailure } from "./setup/steps.ts";
import { NAVI_USAGE } from "./usages.ts";
export { NAVI_USAGE };


function usage(message: string): number {
  process.stderr.write(`fleetd: ${message}\n\nusage:\n${NAVI_USAGE}`);
  return 2;
}

export async function naviCommand(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (verb === undefined) return usage("missing navi command");
  if (!["create", "list", "rename", "archive", "unarchive"].includes(verb)) {
    return usage(`unknown navi command '${verb}'`);
  }
  const v = parse(argv.slice(1), { options: { machine: "str", archived: "bool", hub: "str" }, positionals: true });
  if (v instanceof ArgError) return usage(v.message);
  const out = new Out(isTty());
  let client;
  try {
    client = await connectTo(resolveHome(), v.str("hub"), "fleetd-navi");
  } catch (f) {
    if (isFailure(f)) return out.fail(new Stop(4, f.message, f.fix));
    throw f;
  }
  try {
    if (verb === "create") await create(client, out, v);
    else if (verb === "list") await list(client, v);
    else if (verb === "rename") await rename(client, out, v);
    else await archive(client, out, v, verb === "archive");
    return 0;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return error.code === 2 ? usage(error.message) : out.fail(error);
  }
}

const at = (navi: unknown) => `${s(navi, "/machineId")}/${s(navi, "/projectId")}`;

async function create(client: McpClient, out: Out, v: Parsed) {
  const name = v.positionals.join(" ");
  if (name.trim() === "") throw new Stop(2, "give the Navi a name: fleetd navi create Ada");
  const body = await call(client, "navi_create", { name: name.trim(), machineId: v.str("machine") ?? null });
  const navi = body?.navi;
  out.success(`${s(navi, "/title")} is ready on ${s(navi, "/machineId")}, in ${tilde(s(navi, "/workspaceRoot"))}`);
  out.info(`Say hello in the app, or: fleetd chat ${at(navi)} "hello" --key-file <your human key>`);
}

async function list(client: McpClient, v: Parsed) {
  const body = await call(client, "navi_list", { machineId: v.str("machine") ?? null, archived: v.flag("archived") });
  const navis: any[] = Array.isArray(body?.navis) ? body.navis : [];
  if (navis.length === 0) println("No Navis yet: fleetd navi create <name>");
  for (const n of navis) {
    println(`${at(n)}  ${s(n, "/title")}  ${tilde(s(n, "/workspaceRoot"))}${n.archivedAt !== undefined ? "  (archived)" : ""}`);
  }
}

async function find(client: McpClient, target: string | undefined): Promise<any> {
  if (target === undefined) throw new Stop(2, "give the Navi as <machine>/<id or name>");
  const slash = target.indexOf("/");
  if (slash < 0) throw new Stop(2, `'${target}' is not <machine>/<navi>`);
  const [machine, which] = [target.slice(0, slash), target.slice(slash + 1)];
  const body = await call(client, "navi_list", { machineId: machine, archived: true });
  const navis: any[] = Array.isArray(body?.navis) ? body.navis : [];
  const byName = navis.filter((n) => s(n, "/title") === which);
  const found = navis.find((n) => s(n, "/projectId") === which) ?? (byName.length === 1 ? byName[0] : undefined);
  if (found === undefined) {
    throw new Stop(3, `no single Navi '${which}' on ${machine}`, `fleetd navi list --archived --machine ${machine} shows their ids`);
  }
  return found;
}

const key = (navi: unknown) => ({ machineId: s(navi, "/machineId"), projectId: s(navi, "/projectId") });

async function rename(client: McpClient, out: Out, v: Parsed) {
  const navi = await find(client, v.positionals[0]);
  const name = v.positionals.slice(1).join(" ");
  if (name.trim() === "") throw new Stop(2, "give its new name: fleetd navi rename <machine>/<navi> <name>");
  await call(client, "navi_rename", { ...key(navi), name: name.trim() });
  out.success(`${s(navi, "/title")} is now ${name.trim()}`);
}

async function archive(client: McpClient, out: Out, v: Parsed, archived: boolean) {
  const navi = await find(client, v.positionals[0]);
  await archiveCall(client, { ...key(navi), archived });
  const title = s(navi, "/title");
  out.success(
    archived
      ? `${title} is archived; its chat, memory and folder stay`
      : `${title} is back; its lead starts with your next message`,
  );
}
