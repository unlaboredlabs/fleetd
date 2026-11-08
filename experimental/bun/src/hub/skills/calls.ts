// The lead's `skill_install`, for its own project (crates/fleetd/src/hub/skills/calls.rs), and its `skill_save`
// (saves.rs, W238): it writes one of its project's own skills, new or changed, with no approval, kept as a new version
// with its one line on why. Each posts one quiet chat line. A task makes neither (tasks' policy).
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { titleOf } from "../artifacts/index.ts";
import { chat, jsTake } from "../chat/index.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../leads/seams.ts";
import { nowMs } from "../store/time.ts";
import { isSkillName, WHY_CAP } from "./frontmatter.ts";
import { type Kept, Skills } from "./index.ts";
import { changed, installFrom } from "./tools.ts";
import * as versions from "./versions.ts";

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("skill_install", (caller, call) => install(hub, caller, call));
  leadCalls(hub).register("skill_save", (caller, call) => save(hub, caller, call));
}

const invalid = (why: string) => new ToolError("invalid", `Invalid ${why}.`);

/** The quiet chat line of a skill a lead installed: its name, and `source@commit`. */
function posted(hub: Hub, r: ProjectRef, kept: Kept, source: string, commit: string): void {
  const from = jsTake(`${source}@${commit.slice(0, 12)}`, 280) || "its source";
  const version = kept.changed?.version ?? 1;
  chat(hub).add(r, {
    author: "system",
    text: `Installed the skill ${kept.name} from ${from}`,
    skillSaved: { name: kept.name, version, created: version === 1, why: `installed from ${from}`, installed: from },
  });
}

async function install(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  if (call.op !== "skill_install") throw new ToolError("invalid", `${call.op} is not a skills call.`);
  const { scope, source, skill } = call as { scope?: unknown; source?: unknown; skill?: unknown };
  if (scope !== "project" && scope !== "global") throw invalid("skill_install call: scope is project or global");
  if (typeof source !== "string" || !source) throw invalid("skill_install call: source names where the skill comes from");
  if (skill !== undefined && (typeof skill !== "string" || !isSkillName(skill))) throw invalid("skill_install call: skill is a skill name");
  // Global skills take admin on every machine, which a lead never holds.
  if (scope === "global") {
    throw new ToolError(
      "forbidden",
      "A lead installs skills for its own project only: global ones take an admin.",
      "Install it with scope project, or ask the human to install it globally from Settings > Skills.",
    );
  }
  const r = caller.projectRef;
  const { kept, commit } = await installFrom(hub, "project", r, source, skill as string | undefined, "lead", {
    author: "agent",
    by: titleOf(hub, r),
    atMs: nowMs(hub.clock),
  });
  const names = kept.map((k) => k.name);
  changed(hub, r, names, caller.by);
  for (const k of kept) posted(hub, r, k, source, commit);
  const list = names.map((n) => `fleetd:${n}`).join(", ");
  return {
    installed: names,
    commit,
    next: `Installed ${list}, pinned to this commit; the human updates it on the project's Settings › Agents. Sessions started from now get it (yours from its next start): name it in a brief and the agent uses it.`,
  };
}

function save(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  if (call.op !== "skill_save") throw new ToolError("invalid", `${call.op} is not a skill save.`);
  if (caller.agent.kind !== "lead") throw new ToolError("forbidden", "Only the project's lead saves its skills.");
  const { name, text, why } = call as { name?: unknown; text?: unknown; why?: unknown };
  if (typeof name !== "string" || !isSkillName(name)) throw invalid("skill_save call: name is a skill name");
  if (typeof text !== "string") throw invalid("skill_save call: text is the whole SKILL.md");
  if (typeof why !== "string" || !why || why.length > WHY_CAP || /[\r\n]/.test(why)) throw invalid(`skill_save call: why is one line of 1 to ${WHY_CAP} characters`);
  const r = caller.projectRef;
  const skills = Skills.of(hub);
  const before = skills.get("project", r, name);
  if (before?.install) {
    throw new ToolError("invalid", `${name} was installed from a source, and its updates would replace your change.`, "Save your version under a name of its own.");
  }
  const created = before === undefined;
  const kept = skills.set("project", r, name, text, false, versions.agent(titleOf(hub, r), why, nowMs(hub.clock)));
  const version = kept.changed?.version ?? 1;
  changed(hub, r, [name], caller.by);
  chat(hub).add(r, {
    author: "system",
    text: created ? `Saved a new skill, ${name}: ${why}` : `Updated the skill ${name}: ${why}`,
    skillSaved: { name, version, created, why },
  });
  const off = versions.uses(hub.db, r).get(name)?.off === true;
  return {
    name,
    version,
    created,
    next: off
      ? `Saved as version ${version}. The person turned ${name} off, so your sessions don't get it until they turn it back on.`
      : `Saved as version ${version}; the person sees it in your Skills. Your next session lists it as fleetd:${name}.`,
  };
}
