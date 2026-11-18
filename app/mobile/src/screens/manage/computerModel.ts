// A bot's Computer, the parts with no React: which setups it has (its own directory's, then each other repo's, as the
// desktop's Computer section lists them), and an image's rows in the desktop's words: Image (Ready, Building…,
// Failed, Not built yet), Built, Size; Rebuild only while its machine builds images, there are commands and no build
// runs. A machine that builds none shows no image at all.
import type { ComputerImage, ProjectSummary, WorktreeSetup } from "../../desktop";
import { ago } from "./skillsModel";

export interface SetupTarget {
  /** The repo whose setup it is; absent, the bot's own directory's. */
  readonly repo?: string;
  readonly title: string;
}

/**
 * Its setups in the desktop's order: the bot's own directory's first while it is one of its repos (or it has none),
 * titled Setup when it is the only one; then each other repo's, by name.
 */
export const setupTargets = (p: Pick<ProjectSummary, "machineId" | "projectId" | "title" | "repos">): readonly SetupTarget[] => {
  const repos = p.repos ?? [];
  const isOwn = (r: (typeof repos)[number]) => r.checkout.machineId === p.machineId && r.checkout.projectId === p.projectId;
  const own = repos.find(isOwn);
  const others = repos.filter((r) => !isOwn(r));
  const first: SetupTarget[] = own !== undefined || others.length === 0 ? [{ title: others.length === 0 ? "Setup" : `Setup: ${own?.name ?? p.title}` }] : [];
  return [...first, ...others.map((r) => ({ repo: r.name, title: `Setup: ${r.name}` }))];
};

/** Its commands, one a row; blank lines dropped. */
export const commandsOf = (setup: Pick<WorktreeSetup, "commands"> | undefined): readonly string[] => (setup?.commands ?? []).map((c) => c.trim()).filter((c) => c !== "");

const MB = 1_048_576;
const GB = 1_073_741_824;

/** An image's size as the desktop words it: "640 MB" under a gigabyte, "1.1 GB" from one. */
export const imageSize = (bytes: number): string => (bytes < GB ? `${String(Math.max(1, Math.round(bytes / MB)))} MB` : `${(bytes / GB).toFixed(1)} GB`);

/**
 * Whether its machine keeps images at all: one that can build them says where even before the first (`none` with
 * `where`); a bare `none` is a machine that builds none (no VMs and no hosted provider), whose agents start clean.
 */
const imaged = (image: ComputerImage | undefined): image is ComputerImage => image !== undefined && (image.state !== "none" || image.where !== undefined);

export type ImageTone = "plain" | "busy" | "danger";

export interface ImageRow {
  readonly title: string;
  readonly value: string;
  readonly tone: ImageTone;
  /** Failed: the end of the build's log, opened from the row. */
  readonly log?: string;
}

/**
 * An image's rows: its state, then when the image agents start from now was built and its size (a failed or running
 * build keeps the older one serving, so those show then too). No commands, a machine that builds none, or a hub that
 * doesn't say: none.
 */
export const imageRows = (image: ComputerImage | undefined, hasCommands: boolean, clock: { readonly nowMs: number }): readonly ImageRow[] => {
  if (!imaged(image) || !hasCommands) return [];
  const rows: ImageRow[] = [];
  const log = image.log?.trim();
  if (image.state === "building") rows.push({ title: "Image", value: "Building…", tone: "busy" });
  else if (image.state === "failed") rows.push({ title: "Image", value: "Failed", tone: "danger", ...(log === undefined || log === "" ? {} : { log }) });
  else if (image.builtAt !== undefined) rows.push({ title: "Image", value: "Ready", tone: "plain" });
  else rows.push({ title: "Image", value: "Not built yet", tone: "plain" });
  if (image.builtAt !== undefined) rows.push({ title: "Built", value: ago(image.builtAt, clock), tone: "plain" });
  if (image.builtAt !== undefined && image.bytes !== undefined) rows.push({ title: "Size", value: imageSize(image.bytes), tone: "plain" });
  return rows;
};

/** Rebuild shows while its machine builds images, there are commands and no build runs (one running would be replaced by it). */
export const canRebuild = (image: ComputerImage | undefined, hasCommands: boolean): boolean => imaged(image) && hasCommands && image.state !== "building";

/** Whether a hub event is about this bot's setup or image: the hub's project.settings, `data.image` on an image's change. */
export const touchesComputer = (event: { readonly type: string; readonly machineId?: string; readonly projectId?: string }, p: { readonly machineId: string; readonly projectId: string }): boolean =>
  event.type === "project.settings" && event.machineId === p.machineId && event.projectId === p.projectId;
