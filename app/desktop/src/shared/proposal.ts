// A lead's proposal for a new project (`project_propose`), read from what its approval card shows: all that approving
// it makes. Pure, and shared with the phone: both cards say the same.
import type { ToolPreview } from "./contracts";

export type Proposal = {
  readonly title: string;
  /** The GitHub repo it is cloned from; undefined for a project with none. */
  readonly repo: string | undefined;
  readonly machineId: string;
  readonly path: string;
};

/** Undefined for any other card, and for one that can't be read, which shows as any change does. */
export const proposal = (p: ToolPreview): Proposal | undefined => {
  if (p.server !== "fleetd" || p.tool !== "project_propose") return undefined;
  try {
    const input = JSON.parse(p.input) as { title?: unknown; repo?: unknown; machineId?: unknown; path?: unknown } | null;
    if (typeof input?.title !== "string" || typeof input.machineId !== "string" || typeof input.path !== "string") return undefined;
    return { title: input.title, repo: typeof input.repo === "string" ? input.repo : undefined, machineId: input.machineId, path: input.path };
  } catch {
    return undefined;
  }
};
