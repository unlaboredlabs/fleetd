import fs from "node:fs";
import type { ProjectRef } from "@fleetd/contracts";

/**
 * Bump with a new `prompt-v<n>.md`; never edit a shipped prompt, since running leads were started from it.
 * v0: briefs, asks, decisions and status (M3). v1: delegation through `fleetd task spawn` (M5). v2: done is claimed
 * with `fleetd claim done` and checked by fleetd; writers say what they serve; review tasks end with a verdict (M6).
 */
export const LEAD_PROMPT_VERSION = "v2";

/** Read from beside this module: the source tree, or the CLI bundle's dist, where its build copies the prompts. */
export const readLeadPrompt = () => fs.readFileSync(new URL(`./prompt-${LEAD_PROMPT_VERSION}.md`, import.meta.url), "utf8");

export const renderLeadPrompt = (template: string, project: { readonly ref: ProjectRef; readonly title: string }) =>
  template
    .replaceAll("{{project}}", project.title)
    .replaceAll("{{projectRef}}", `${project.ref.machineId}/${project.ref.projectId}`)
    .trimEnd();
