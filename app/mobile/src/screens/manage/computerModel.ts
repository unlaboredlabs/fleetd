// A bot's Computer, the parts with no React: which setups it has (its own directory's, then each other repo's, as the
// desktop's Computer section lists them), and an image's rows in the desktop's words: Image (Ready, Building…,
// Failed, Not built yet), Built, Size; Rebuild only while its machine builds images, there are commands and no build
// runs. A machine that builds none shows no image at all.
import type { ComputerChoice, ComputerImage, ComputerPick, ProjectSummary, WorktreeSetup } from "../../desktop";
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
 * `where`); a bare `none` is a machine that builds none (a self-hosted hub's), whose agents start clean.
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

/** One row of Runs on: Automatic (no pick) or one real machine the bot may have, as the hub words it. */
export interface RunsOnRow {
  readonly key: string;
  readonly title: string;
  /** What to send: a pick, or null to drop the pick (Automatic). */
  readonly pick: ComputerPick | null;
  readonly selected: boolean;
  /** Why it can't be picked now; it isn't tappable then. */
  readonly why?: string;
  /** Said once under the last of the rows side by side that share a `why` (a provider's every size), with the
   * command that fixes it when there is one. */
  readonly note?: { readonly why: string; readonly fix?: string };
}

const same = (a: Pick<ComputerChoice, "kind" | "cpu" | "memGb">, b: ComputerPick | undefined): boolean =>
  b !== undefined && a.kind === b.kind && a.cpu === b.cpu && a.memGb === b.memGb;

/**
 * Where every agent of the bot runs, as the desktop's Runs on lists it: Automatic, then each of the hub's choices in its
 * order, provider and exact size together ("boat.dev · 4 vCPU / 8 GB"), the pick checked. One that can't be used now isn't
 * tappable (the pick itself stays checked, saying its agents wait), and why is said once, under the last of the rows
 * beside it that can't for the same reason. None when there is nothing to pick and nothing picked, or the hub is too
 * old to say.
 */
export const runsOnRows = (settings: { readonly computer?: ComputerPick; readonly computers?: readonly ComputerChoice[] } | undefined): readonly RunsOnRow[] => {
  const choices = settings?.computers;
  if (choices === undefined || (choices.length === 0 && settings?.computer === undefined)) return [];
  const pick = settings?.computer;
  return [
    { key: "auto", title: "Automatic", pick: null, selected: pick === undefined },
    ...choices.map((c, i) => ({
      key: `${c.kind}:${String(c.cpu)}:${String(c.memGb)}`,
      title: c.label,
      pick: { kind: c.kind, cpu: c.cpu, memGb: c.memGb },
      selected: same(c, pick),
      ...(c.unavailable === undefined ? {} : { why: c.unavailable }),
      ...(c.unavailable === undefined || choices[i + 1]?.unavailable === c.unavailable
        ? {}
        : { note: { why: c.unavailable, ...(c.fix === undefined ? {} : { fix: c.fix }) } }),
    })),
  ];
};
