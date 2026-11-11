// prompt_get, prompt_set and session_prompt_get, and the prompt events
// (prompts/mod.rs `start`, `changed`).
import type { PromptScope, PromptSetInput, PromptSetOutput, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { refOf, warnings } from "./render.ts";
import { retired } from "./retired.ts";
import { entryOr, PromptError, prompts } from "./store.ts";

function toolError(e: unknown): unknown {
  if (!(e instanceof PromptError)) return e;
  if (e.kind === "invalid") return new ToolError("invalid", e.message);
  if (e.kind === "not_found") return new ToolError("not_found", e.message, "prompt_get without an id lists every prompt.");
  return new ToolError("failed", e.message);
}

/** A retired id gets told where its words went, instead of a bare "no such prompt". */
function entryOrRetired(id: string) {
  try {
    return entryOr(id);
  } catch (e) {
    const r = retired(id);
    if (!r) throw toolError(e);
    throw new ToolError(
      "not_found",
      `fleetd retired ${id}: ${r.why}.`,
      r.target === undefined
        ? `prompt_get without an id shows any edit you made to ${id} under orphans.`
        : `Edit ${r.target} instead; prompt_get without an id shows any edit you made to ${id} under orphans.`,
    );
  }
}

function readableProject(hub: Hub, caller: Caller, r: ProjectRef | undefined): void {
  if (!r) return;
  requireRole(caller, "read", r.machineId);
  if (!store(hub).projectGet(r)) {
    throw new ToolError("not_found", `No project ${r.projectId} on ${r.machineId}.`, "project_get without a projectId lists them.");
  }
}

/** Whether some grant on every machine gives at least `role` (api/grants.rs `allows_everywhere`). */
const allowsEverywhere = (caller: Caller, role: "admin") =>
  caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

/**
 * A project's prompt: admin on its machine, or a person's device that may operate there. A hub-wide prompt reaches
 * every teammate's agents, so only admin on every machine changes it (D209).
 */
function mayEdit(caller: Caller, scope: PromptScope, r: ProjectRef | undefined): void {
  if (scope === "project" && r) {
    if (allows(caller, "admin", r.machineId) || (isHuman(caller) && allows(caller, "operate", r.machineId))) return;
    throw new ToolError(
      "forbidden",
      "Prompts steer every agent they reach; this key may not change them there.",
      "Use the desktop app, or a key from fleetd hub key create --role admin.",
    );
  }
  if (allowsEverywhere(caller, "admin")) return;
  throw new ToolError(
    "forbidden",
    "Hub-wide prompts and instructions reach every teammate's agents: only the hub's owners and admins change them.",
    "Ask an owner or admin (Settings › Hub › Every project › Instructions), or edit this project's own text instead.",
  );
}

/** `prompt.changed`: an override was saved (`data.ref`, `data.warnings`) or reset. The text stays out of the event. */
export function changed(hub: Hub, id: string, scope: PromptScope, project: ProjectRef | undefined, data: Record<string, unknown>): void {
  events(hub).append({
    at: isoMs(nowMs(hub.clock)),
    type: "prompt.changed",
    ...(project ? { machineId: project.machineId, projectId: project.projectId } : {}),
    summary: project ? `Prompt ${id} changed for ${project.machineId}/${project.projectId}` : `Prompt ${id} changed hub-wide`,
    data: { ...data, id, scope, ...(project ? { projectRef: project } : {}) },
  });
}

/**
 * At hub start: keeps this release's shipped texts and raises one `prompt.default_changed` per override whose default
 * changed since it was edited (once per new default). The override stays in effect.
 */
export function start(hub: Hub): void {
  const p = prompts(hub.db);
  p.keepDefaults();
  const at = isoMs(nowMs(hub.clock));
  for (const stale of p.stale()) {
    const e = stale.entry;
    const current = refOf(e.id, e.default);
    const project = stale.project ? `${stale.project.machineId}/${stale.project.projectId}` : undefined;
    const seen = hub.db.all<{ seen: number }>(
      "SELECT EXISTS (SELECT 1 FROM events WHERE type = 'prompt.default_changed' AND json_extract(data, '$.data.id') = ? AND json_extract(data, '$.data.current') = ? AND IFNULL(json_extract(data, '$.data.project'), '') = ?) AS seen",
      [e.id, current, project ?? ""],
    )[0]?.seen;
    if (seen) continue;
    events(hub).append({
      at,
      type: "prompt.default_changed",
      ...(stale.project ? { machineId: stale.project.machineId, projectId: stale.project.projectId } : {}),
      summary: `fleetd changed the default of ${e.id}, which you edited${project ? ` for ${project}` : ""}; yours stays in effect until you review it`,
      data: {
        id: e.id,
        scope: project ? "project" : "global",
        projectRef: stale.project ?? null,
        project: project ?? null,
        base: stale.base ?? null,
        current,
      },
      attention: "loud",
    });
  }
}

const notReset = (ref: string): PromptSetOutput => ({ ref, warnings: [], next: "Not reset: dryRun." });

/** `prompt_set` with `reset: true`: back to the next level, or a retired prompt's edit deleted. */
function reset(hub: Hub, caller: Caller, input: PromptSetInput): PromptSetOutput {
  const r = input.projectRef;
  const old = retired(input.id);
  if (old) {
    mayEdit(caller, input.scope, r);
    readableProject(hub, caller, r);
    // A retired prompt sends nothing: what is in effect is no text at all.
    const none = refOf(old.id, "");
    if (input.dryRun === true) return notReset(none);
    prompts(hub.db).resetRetired(old, input.scope, r);
    changed(hub, old.id, input.scope, r, { retired: true });
    return { ref: none, warnings: [], next: `Your edit to ${old.id} is deleted; fleetd retired that prompt.` };
  }
  const e = entryOr(input.id);
  mayEdit(caller, input.scope, r);
  readableProject(hub, caller, r);
  if (input.dryRun === true) {
    const d = prompts(hub.db).detail(e, r);
    const next = input.scope === "project" ? d.global?.ref : d.project?.ref;
    return notReset(next ?? d.default.ref);
  }
  prompts(hub.db).reset(e, input.scope, r);
  changed(hub, e.id, input.scope, r, {});
  return { ref: prompts(hub.db).detail(e, r).effective.ref, warnings: [], next: "Reset: the next level's text is in effect." };
}

function guarded<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw toolError(e);
  }
}

export function register(tools: Registry): void {
  tools.add("prompt_get", (hub, caller, input) =>
    guarded(() => {
      const r = input.projectRef;
      readableProject(hub, caller, r);
      if (input.id === undefined) {
        const orphans = prompts(hub.db).orphans(r);
        return {
          prompts: prompts(hub.db).list(r),
          orphans,
          next:
            orphans.length === 0
              ? "prompt_get with an id shows one prompt's texts, placeholders and safety rules."
              : "orphans are your edits to prompts fleetd retired: copy what you need into suggestedTarget, then delete the old one with prompt_set (reset true).",
        };
      }
      const prompt = prompts(hub.db).detail(entryOrRetired(input.id), r);
      return {
        prompt,
        ...(prompt.stale
          ? {
              next: `fleetd changed this prompt's default; yours is still in effect. Save the merged text (or yours) with base ${prompt.stale.current.ref}, or reset it with reset true.`,
            }
          : {}),
      };
    }),
  );

  tools.add("prompt_set", (hub, caller, input) =>
    guarded(() => {
      // A forgotten text must never wipe a person's edit: only an explicit reset deletes one.
      const resetting = input.reset === true;
      if (input.text === undefined && resetting) return reset(hub, caller, input);
      if (input.text !== undefined && resetting) throw new ToolError("invalid", "Give text to save or reset: true to go back, not both.");
      if (input.text === undefined) {
        throw new ToolError("invalid", "No text to save. Give text, or reset: true to go back to the next level.");
      }
      const text = input.text;
      const e = entryOrRetired(input.id);
      const r = input.projectRef;
      mayEdit(caller, input.scope, r);
      readableProject(hub, caller, r);
      if (input.dryRun === true) return { ref: refOf(e.id, text), warnings: warnings(e, text), next: "Not saved: dryRun." };
      const saved = prompts(hub.db).set(e, input.scope, r, text, input.base);
      changed(hub, e.id, input.scope, r, { ref: saved.ref, warnings: saved.warnings.map((w) => w.code) });
      return {
        ref: saved.ref,
        warnings: saved.warnings,
        next: "New sessions get it now; a running lead gets it at its next fresh lead_start, a task at its next attempt.",
      };
    }),
  );

  tools.add("session_prompt_get", (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    const session = prompts(hub.db).session(input.machineId, input.threadId);
    if (!session) {
      throw new ToolError(
        "not_found",
        `fleetd kept no first message for thread ${input.threadId} on ${input.machineId}: it did not start it, or started it before prompts were kept.`,
        "thread_tail shows the thread's messages.",
      );
    }
    return { session, next: "thread_tail shows its later messages." };
  });
}
