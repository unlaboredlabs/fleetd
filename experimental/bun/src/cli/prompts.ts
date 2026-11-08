// `fleetd prompts …` and `fleetd instructions …` (crates/fleetd/src/cli/prompts.rs): every prompt fleetd sends a
// model, read and edited on the hub machine, on src/hub/prompts' store. They open the hub home directly (as `hub key`
// does): an edit is a file the running hub reads at the next session it starts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRef, PromptScope } from "../shared/contracts.ts";
import { ENTRIES, getEntry, INSTRUCTIONS, perProject, type RegistryEntry } from "../hub/prompts/entry.ts";
import { warnings } from "../hub/prompts/render.ts";
import { Prompts } from "../hub/prompts/store.ts";
import { HubDb } from "../hub/store/db.ts";
import { HubStore } from "../hub/store/hub_store.ts";
import { ArgError, parse } from "./args.ts";
import { isMachineId, resolveHome } from "./common.ts";
import { createPatch } from "./diff.ts";
import { sortKeys } from "./json.ts";
import { padEnd } from "./project.ts";
import { type CliResult, err, ok } from "./result.ts";
import { appendEvent } from "./store.ts";
import { PROMPTS_USAGE } from "./usages.ts";
export { PROMPTS_USAGE };

const usage = (message: string) => err(2, `fleetd: ${message}\n\nusage:\n${PROMPTS_USAGE}`);

function splitRef(raw: string, what: string): [string, string] {
  const slash = raw.indexOf("/");
  if (slash < 0 || slash === raw.length - 1) throw new ArgError(`${what} must be <machine>/<id>, got '${raw}'`);
  const m = raw.slice(0, slash);
  if (!isMachineId(m)) throw new ArgError(`'${m}' is not a machine id`);
  return [m, raw.slice(slash + 1)];
}

/** `fleetd instructions show|edit …` is `fleetd prompts show|edit instructions …`. */
export async function instructionsCommand(argv: string[]): Promise<CliResult> {
  const verb = argv[0];
  if (verb === "show" || verb === "edit") return promptsCommand([verb, INSTRUCTIONS, ...argv.slice(1)]);
  return usage(`unknown instructions command '${verb ?? ""}'`);
}

export async function promptsCommand(argv: string[]): Promise<CliResult> {
  const verb = argv[0];
  if (verb === undefined) return usage("missing prompts command");
  const v = parse(argv.slice(1), { options: { project: "str", default: "bool", session: "str" }, positionals: true });
  if (v instanceof ArgError) return usage(v.message);
  let named: [string, string] | undefined;
  try {
    const raw = v.str("project");
    if (raw !== undefined) named = splitRef(raw, "--project");
  } catch (error) {
    return usage((error as Error).message);
  }
  const home = resolveHome();
  if (!existsSync(join(home, "hub.sqlite"))) return err(1, `fleetd: no hub in ${home}; run this on the hub machine\n`);
  let db: HubDb;
  try {
    db = HubDb.open(home);
  } catch (error) {
    return err(1, `fleetd: ${(error as Error).message}\n`);
  }
  try {
    return await run(db, verb, v, named);
  } finally {
    db.conn.close();
  }
}

async function run(db: HubDb, verb: string, v: Exclude<ReturnType<typeof parse>, ArgError>, named: [string, string] | undefined): Promise<CliResult> {
  let project: ProjectRef | undefined;
  if (named !== undefined) {
    const found = findProject(db, named[0], named[1]);
    if (typeof found === "string") return err(2, `fleetd: ${found}\n`);
    project = found;
  }
  const prompts = new Prompts(db);
  if (verb === "list") return ok(list(prompts, project));
  const session = v.str("session");
  if (verb === "show" && session !== undefined) {
    let m: string;
    let t: string;
    try {
      [m, t] = splitRef(session, "--session");
    } catch (error) {
      return usage((error as Error).message);
    }
    const kept = prompts.session(m, t);
    if (kept === undefined) {
      return err(1, `fleetd: no first message kept for ${session}: fleetd did not start it, or started it before prompts were kept\n`);
    }
    return ok(`${kept.text}\n`);
  }
  const id = v.positionals[0];
  if (id === undefined) return usage(`prompts ${verb} needs a prompt id (see fleetd prompts list)`);
  const e = getEntry(id);
  if (e === undefined) return err(2, `fleetd: There is no prompt ${id}. See fleetd prompts list.\n`);
  if (project !== undefined && !perProject(e)) return usage(`${e.id} has one hub-wide text; leave out --project`);
  const scope: PromptScope = project !== undefined ? "project" : "global";
  let text: string;
  try {
    if (verb === "show") {
      const detail = prompts.detail(e, project);
      text = v.flag("default") ? detail.default.text : detail.effective.text;
    } else if (verb === "diff") text = diff(prompts, e, project);
    else if (verb === "reset") {
      prompts.reset(e, scope, project);
      announce(db, e, scope, project, {});
      const detail = prompts.detail(e, project);
      const level = { default: "the shipped text", global: "the hub-wide override", project: "the project override" }[detail.scope];
      text = `${e.id} is back to ${level} (${detail.effective.ref}).`;
    } else if (verb === "edit") text = await edit(db, prompts, e, scope, project);
    else return usage(`unknown prompts command '${verb}'`);
  } catch (error) {
    return err(1, `fleetd: ${(error as Error).message}\n`);
  }
  return ok(text === "" || text.endsWith("\n") ? text : `${text}\n`);
}

/** `--project <machine>/<id or title>` as the project it names on this hub, or why not. */
function findProject(db: HubDb, machineId: string, which: string): ProjectRef | string {
  let projects: { projectId: string; title: string }[];
  try {
    projects = new HubStore(db).projectsList(machineId) as never;
  } catch (error) {
    return (error as Error).message;
  }
  const byTitle = projects.filter((p) => p.title === which);
  const found = projects.find((p) => p.projectId === which) ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  if (found === undefined) {
    return `no single project '${which}' on ${machineId}; fleetd project list --machine ${machineId} shows their ids`;
  }
  return { machineId, projectId: found.projectId } as ProjectRef;
}

function list(prompts: Prompts, project?: ProjectRef): string {
  const width = Math.max(0, ...ENTRIES.map((e) => e.id.length));
  return prompts
    .list(project)
    .map((r) => `${padEnd(r.id, width)}  ${padEnd(r.kind, 12)} ${padEnd(r.scope, 8)}${r.stale ? " update" : ""}  ${r.title}\n`)
    .join("");
}

function diff(prompts: Prompts, e: RegistryEntry, project?: ProjectRef): string {
  const detail = prompts.detail(e, project);
  const stale = detail.stale;
  if (stale) {
    const base = stale.base?.text ?? "";
    return `fleetd changed the shipped text since you edited it.\n\n# what fleetd changed (your base -> shipped now)\n${createPatch(base, stale.current.text)}\n# what you changed (your base -> yours)\n${createPatch(base, stale.yours.text)}`;
  }
  if (detail.effective.ref === detail.default.ref) return `${e.id} is the shipped text.\n`;
  return createPatch(detail.default.text, detail.effective.text);
}

/** `prompt.changed` in the hub's log (hub/prompts `changed`): the text stays out of it. */
function announce(db: HubDb, e: RegistryEntry, scope: PromptScope, project: ProjectRef | undefined, data: Record<string, unknown>) {
  appendEvent(db, {
    type: "prompt.changed",
    ...(project ? { machineId: project.machineId, projectId: project.projectId } : {}),
    summary: project ? `Prompt ${e.id} changed for ${project.machineId}/${project.projectId}` : `Prompt ${e.id} changed hub-wide`,
    data: sortKeys({ ...data, id: e.id, scope, ...(project ? { projectRef: project } : {}) }),
  });
}

/** The text in effect (the 3-way merge when a release changed the default you edited), in the editor; what the edit
 * may break; saved unless told not to. */
async function edit(db: HubDb, prompts: Prompts, e: RegistryEntry, scope: PromptScope, project?: ProjectRef): Promise<string> {
  const detail = prompts.detail(e, project);
  const stale = detail.stale;
  let start: string;
  let base: string;
  if (stale) {
    process.stderr.write(
      `fleetd changed the shipped ${e.id} since you edited it: the file holds both, merged${stale.conflicts ? "; resolve the <<<<<<< blocks" : ""}.\n`,
    );
    [start, base] = [stale.merged, stale.current.ref];
  } else [start, base] = [detail.effective.text, detail.default.ref];
  // A file only this user can read, under a name another user can't guess or plant first.
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), `fleetd-${e.id}-`));
  const file = join(dir, `${e.id}.md`);
  let text: string;
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  try {
    writeFileSync(file, start, { mode: 0o600 });
    // Through the shell, so an editor with arguments ("code --wait") works.
    let status: number | null;
    try {
      status = Bun.spawnSync(["sh", "-c", `${editor} "$1"`, "sh", file], { stdio: ["inherit", "inherit", "inherit"] }).exitCode;
    } catch (error) {
      throw new Error(`cannot run ${editor}: ${(error as Error).message}`);
    }
    if (status !== 0) throw new Error(`${editor} exited with exit status: ${status}; nothing saved`);
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`cannot read the edited file: ${(error as Error).message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (text === start && !stale) return "No change.";
  for (const w of warnings(e, text)) process.stderr.write(`warning: ${w.message}\n`);
  if (!(await confirm("Save? [Y/n] "))) return "Not saved.";
  const saved = prompts.set(e, scope, project, text, base);
  announce(db, e, scope, project, { ref: saved.ref, warnings: saved.warnings.map((w) => w.code) });
  return `Saved ${saved.ref}. New sessions get it now; a running lead gets it at its next fresh start (lead_start with fresh), a task at its next attempt.`;
}

async function confirm(question: string): Promise<boolean> {
  process.stderr.write(question);
  let line = "";
  try {
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      line += decoder.decode(value, { stream: true });
      if (line.includes("\n")) break;
    }
    reader.releaseLock();
  } catch {
    return false;
  }
  return !["n", "N", "no", "No"].includes(line.split("\n")[0]!.trim());
}
