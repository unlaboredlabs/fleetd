import type { Effort } from "@fleetd/contracts";

export const DEFAULT_TASK_MODEL = "claude-opus-5-5";
export const DEFAULT_TASK_EFFORT: Effort = "high";

interface ModelEffort {
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
}

/**
 * Each of model and effort independently: the spawn flag, then the policy file's defaults, then the project's
 * settings, then claude-opus-5-5 / high. Medium only ever comes from one of those saying so.
 */
export const resolveModelEffort = (layers: {
  readonly flag: ModelEffort;
  readonly policy?: ModelEffort | undefined;
  readonly project?: ModelEffort | undefined;
}): { readonly model: string; readonly effort: Effort } => {
  const order = [layers.flag, layers.policy ?? {}, layers.project ?? {}];
  return {
    model: order.find((l) => l.model !== undefined)?.model ?? DEFAULT_TASK_MODEL,
    effort: order.find((l) => l.effort !== undefined)?.effort ?? DEFAULT_TASK_EFFORT,
  };
};
