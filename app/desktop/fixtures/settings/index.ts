// Settings' fixture data. The shared fixtures get what Settings asks beyond the recorded traffic (the projects for
// the pickers, the dry run, retention, a prompt whose default changed), and `settings-prompts` is the whole real
// registry from the fake prompt hub: every prompt's real text, a hub-wide edit made against an older default (the
// 3-way Update view), a project's own edit, and the instructions at both levels.
import fs from "node:fs";
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import { asText, clone, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { PROJECTS, PromptHub, type RegistryEntry } from "./promptHub.ts";

const registry = (
  JSON.parse(fs.readFileSync(new URL("../../src/renderer/screens/settings/fixture/registry.json", import.meta.url), "utf8")) as {
    prompts: RegistryEntry[];
  }
).prompts;

const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

/** ProjectSummary in full, as the schema wants it. */
const projectSummary = (p: (typeof PROJECTS)[number]): JsonObject => ({
  machineId: p.machineId,
  projectId: p.projectId,
  title: p.title,
  workspaceRoot: `/home/dev/src/${p.projectId}`,
  threads: { running: 1, waiting: 0, idle: 2, failed: 0 },
  lastActivityAt: "2026-10-19T10:21:00.000Z",
});

/** What Settings calls besides the prompt reads. */
function basics(f: Fixture) {
  if (f.answers("projects_list").length === 0) f.answer("projects_list", undefined, { projects: PROJECTS.map(projectSummary) });
  f.answer("time_retention_set", undefined, { retentionDays: 30 });
  // Settings reads the retention and stored size from a breakdown of the fleet's last hour, at whatever time it is.
  const fleet = f.answers("time_breakdown").find((a) => isObject(a.input?.["scope"]) && a.input["scope"]["kind"] === "fleet");
  if (fleet && !f.output("time_breakdown", { scope: { kind: "fleet" } })) f.answer("time_breakdown", { scope: { kind: "fleet" } }, clone(fleet.output));
  // The dry run, for any text: a fixture cannot know what will be typed, so it answers with no warnings.
  f.answer("prompt_set", { dryRun: true }, { ref: "lead.start@5e771ed000", warnings: [] });
}

/** A recorded prompt_get turned into one whose default changed since the human edited it (the Update view). */
function staled(detail: JsonObject): JsonObject {
  const d = clone(detail);
  const def = isObject(d["default"]) ? d["default"] : { ref: "", text: "" };
  const id = asText(d["id"]);
  const text = asText(def["text"]);
  const base = { ref: `${id}@0ba5e0ba5e`, text: text.replace(/[^\n]*\n?$/u, "") };
  const note = "Keep each message under 200 words.";
  const yours = { ref: `${id}@0f0f0f0f0f`, text: `${base.text}\n${note}\n` };
  d["scope"] = "global";
  d["global"] = { ...yours, base: base.ref };
  d["effective"] = yours;
  d["stale"] = { scope: "global", base, current: def, yours, merged: `${text}\n${note}\n`, conflicts: false };
  return d;
}

export default defineGroup({
  extend: {
    typical: basics,
    "long-text": basics,
    empty: (f) => {
      basics(f);
      // An empty hub still has every prompt; the recording read none of them.
      const hub = new PromptHub(registry, { edits: false });
      for (const { id } of hub.prompts) {
        const got = hub.answer("prompt_get", { id });
        if (got.ok && f.output("prompt_get", { id }) === undefined) f.answer("prompt_get", { id }, json(got.output));
      }
    },
    "many-prompts": (f) => {
      basics(f);
      // The list marks some prompts stale; their reads carry a 3-way update to match.
      const stale = new Set<string>();
      for (const a of f.answers("prompts_list")) {
        const prompts = isObject(a.output) ? a.output["prompts"] : undefined;
        for (const p of Array.isArray(prompts) ? prompts : []) if (isObject(p) && p["stale"] === true) stale.add(asText(p["id"]));
      }
      f.update("prompt_get", (out) => (isObject(out) && stale.has(asText(out["id"])) ? staled(out) : out));
    },
  },
  fixtures: (base) => {
    const hub = new PromptHub(registry);
    const f = Fixture.from(
      base("typical"),
      "settings-prompts",
      "Every prompt of this fleetd with its real text, edits hub-wide and for acme/storefront, one default changed under an edit",
    );
    f.drop("prompts_list");
    f.drop("prompt_get");
    f.drop("projects_list");
    basics(f);
    // Hub-wide, and acme/storefront (which has its own edits); the picker's other projects read as hub-wide.
    for (const projectRef of [undefined, { machineId: "devbox", projectId: "storefront" }]) {
      const scope = projectRef ? { projectRef } : {};
      const list = hub.answer("prompts_list", scope);
      if (list.ok) f.answer("prompts_list", projectRef ? scope : undefined, json(list.output));
      for (const { id } of hub.prompts) {
        const got = hub.answer("prompt_get", { id, ...scope });
        if (got.ok) f.answer("prompt_get", { id, ...scope }, json(got.output));
      }
    }
    return [f];
  },
});
