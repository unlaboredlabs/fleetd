// Try it's data from the hub (contracts preview.rs, mcp.rs): a project's previews and agents' suggestions
// (previews_list, read again on each preview.state event), and the person's acts on them: Try it (preview_start, only
// when none runs), End (preview_end) and feedback (attachment_put for the screenshot, then preview_feedback). A hub
// without previews_list shows no Try it at all. A refusal says why in plain words.
import { useSyncExternalStore } from "react";
import type { Preview, PreviewOf, PreviewsListOutput, PreviewSuggestion } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { CallError, type DataLayer } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { toast } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { previewFor, sameOf, suggestionFor, tryAction, wirePins, type Pin, type TryAction } from "./model";
import { openTry } from "./open";

const NO_PREVIEWS: readonly Preview[] = [];
const NO_SUGGESTIONS: readonly PreviewSuggestion[] = [];

export interface Previews {
  readonly previews: readonly Preview[];
  readonly suggestions: readonly PreviewSuggestion[];
  /** Absent: the hub didn't say, so Try it is offered and the hub decides. */
  readonly canStart: boolean | undefined;
  /** The hub runs previews: it answered previews_list, or is still asked. False for a hub without the tool. */
  readonly on: boolean;
}

/** The hub has no previews_list: a hub from before Try it. */
const lacksTool = (error: unknown): boolean => error instanceof CallError && error.error.code === "not_found";

/** A project's previews and suggestions, as the hub lists them. */
export function usePreviews(project: ProjectKey): Previews {
  const projectRef = { machineId: project.machineId, projectId: project.projectId };
  const q = useToolQuery("previews_list", { projectRef });
  return {
    previews: q.data?.previews ?? NO_PREVIEWS,
    suggestions: q.data?.suggestions ?? NO_SUGGESTIONS,
    canStart: q.data?.canStart,
    on: !lacksTool(q.error),
  };
}

/** What a PR's (or an order's) Try it shows and does. */
export interface TryIt {
  readonly preview: Preview | undefined;
  readonly suggestion: PreviewSuggestion | undefined;
  readonly action: TryAction;
  readonly canStart: boolean | undefined;
  readonly on: boolean;
  /** Its Try it was pressed and the hub hasn't answered yet. */
  readonly asking: boolean;
}

export function useTryIt(project: ProjectKey, of: PreviewOf): TryIt {
  const all = usePreviews(project);
  const asking = useAsking(of);
  const preview = previewFor(all.previews, of);
  return {
    preview,
    suggestion: preview === undefined ? suggestionFor(all.suggestions, of) : undefined,
    action: tryAction(preview, all.canStart),
    canStart: all.canStart,
    on: all.on,
    asking,
  };
}

// Try it pressed, not answered yet: the button holds and the view says it's asking, wherever each shows.
let asking: readonly PreviewOf[] = [];
const listeners = new Set<() => void>();
const setAsking = (of: PreviewOf, on: boolean): void => {
  asking = on ? [...asking, of] : asking.filter((x) => !sameOf(x, of));
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useAsking = (of: PreviewOf): boolean => useSyncExternalStore(subscribe, () => asking.some((x) => sameOf(x, of)));

/** The hub's refusal in plain words: a key that may only open running previews is told what would start one. */
export const refusalWords = (error: HubError): string => {
  if (error.code === "forbidden") return "This device’s key can open a preview that is running, but not start one. A key with admin or operate access can.";
  if (error.code === "offline" || error.code === "disconnected" || error.code === "timeout") return "The hub couldn’t be reached. Try again once you’re connected.";
  return error.fix === undefined || error.fix === "" ? error.message : `${error.message} ${error.fix}`;
};

/** Puts the hub's answer in every previews_list read at once (its preview.state event reads them again anyway). */
const put = (layer: DataLayer, preview: Preview): void => {
  layer.queryClient.setQueriesData<PreviewsListOutput>({ queryKey: ["call", "previews_list"] }, (old) => {
    if (old === undefined) return old;
    const rest = old.previews.filter((p) => p.previewId !== preview.previewId);
    return { ...old, previews: [preview, ...rest], suggestions: old.suggestions.filter((x) => !sameOf(x.of, preview.of)) };
  });
};

/**
 * Try it: opens the PR's Try it on the preview that is starting or ready, and starts one only when none is. A key that
 * may not start one is never offered this (`action` "none").
 */
export async function tryIt(layer: DataLayer, project: ProjectKey, of: PreviewOf, action: TryAction): Promise<void> {
  if (of.kind === "pr") openTry(project, of.repo, of.number);
  if (action !== "start" || asking.some((x) => sameOf(x, of))) return;
  setAsking(of, true);
  const out = await layer.call("preview_start", { projectRef: { machineId: project.machineId, projectId: project.projectId }, of, target: "web" });
  setAsking(of, false);
  if (out.ok) put(layer, out.output.preview);
  else toast({ title: "Couldn’t start the preview", description: refusalWords(out.error), tone: "danger", key: `preview:${JSON.stringify(of)}` });
}

/** End: the machine throws the preview away. */
export async function endPreview(layer: DataLayer, preview: Preview): Promise<boolean> {
  const out = await layer.call("preview_end", { previewId: preview.previewId });
  if (out.ok) put(layer, out.output.preview);
  else toast({ title: "Couldn’t end the preview", description: refusalWords(out.error), tone: "danger", key: `preview-end:${preview.previewId}` });
  return out.ok;
}

export type Sent = { readonly ok: true; readonly to: string } | { readonly ok: false; readonly words: string };

/**
 * Sends the person's pins as a fix request: the screenshot with its pins drawn (when the frame gave one) goes up first
 * as an attachment, then preview_feedback with the pins, the file and, when asked, the last 30 s of the session.
 */
export async function sendFeedback(
  layer: DataLayer,
  preview: Preview,
  feedback: { readonly pins: readonly Pin[]; readonly at: string | undefined; readonly shotB64: string | undefined; readonly clip: boolean },
): Promise<Sent> {
  const files: string[] = [];
  if (feedback.shotB64 !== undefined) {
    const shot = await layer.call("attachment_put", { name: "screenshot-1.png", mime: "image/png", dataB64: feedback.shotB64 }, { timeoutMs: 60_000 });
    if (!shot.ok) return { ok: false, words: `The screenshot didn’t upload: ${refusalWords(shot.error)}` };
    files.push(shot.output.attachmentId);
  }
  const out = await layer.call("preview_feedback", {
    previewId: preview.previewId,
    pins: wirePins(feedback.pins, feedback.at),
    files,
    ...(feedback.clip ? { clipSeconds: CLIP_SECONDS } : {}),
  });
  return out.ok ? { ok: true, to: out.output.deliveredTo } : { ok: false, words: refusalWords(out.error) };
}

/** How much of the session's recording goes with feedback. */
export const CLIP_SECONDS = 30;
