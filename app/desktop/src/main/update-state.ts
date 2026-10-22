// The app update's state machine, kept free of electron so it is unit-tested on its own: what electron-updater
// reports and what the person asks for go in, the state the page shows and what main must do come out.
import type { AppUpdate } from "../shared/updates";

export type UpdateInput =
  /** A check starts; `manual` when someone asked (the menu, the palette), which shows "Checking…" and its failure. */
  | { readonly type: "check"; readonly manual: boolean }
  | { readonly type: "available"; readonly version: string }
  | { readonly type: "none" }
  | { readonly type: "progress"; readonly percent: number }
  | { readonly type: "downloaded"; readonly version: string }
  | { readonly type: "error"; readonly reason: string }
  | { readonly type: "notes"; readonly notes: readonly string[] }
  /** "Update and restart" (or "Restart to update", or the deb's Download). */
  | { readonly type: "install" }
  /** "Not now" after "Update and restart": the download goes on, without the restart. */
  | { readonly type: "keep" };

/** What main does besides showing the new state. */
export type UpdateEffect = "quit-and-install" | "open-download" | null;

export interface Machine {
  readonly app: AppUpdate;
  /** The deb only checks; it can't download or install itself. */
  readonly deb: boolean;
}

const notesOf = (app: AppUpdate): readonly string[] =>
  app.kind === "available" || app.kind === "ready" || app.kind === "manual" ? app.notes : [];

type Found = Extract<AppUpdate, { kind: "available" | "ready" | "manual" }>;
const found = (app: AppUpdate): app is Found => app.kind === "available" || app.kind === "ready" || app.kind === "manual";

export const step = (m: Machine, input: UpdateInput): [AppUpdate, UpdateEffect] => {
  const { app } = m;
  switch (input.type) {
    case "check":
      // Found already: the check can't say anything the page doesn't show. A background check never shows itself.
      return [input.manual && !found(app) ? { kind: "checking" } : app, null];
    case "available":
      // A newer build while one is ready: electron-updater downloads it, and the ready one stays offered until then.
      if (app.kind === "ready") return [app, null];
      if (m.deb) return [{ kind: "manual", version: input.version, notes: notesOf(app) }, null];
      return [
        {
          kind: "available",
          version: input.version,
          notes: notesOf(app),
          percent: app.kind === "available" && app.version === input.version ? app.percent : null,
          restart: app.kind === "available" && app.restart,
        },
        null,
      ];
    case "none":
      return [found(app) ? app : { kind: "current" }, null];
    case "progress":
      return [app.kind === "available" ? { ...app, percent: Math.max(0, Math.min(100, Math.floor(input.percent))) } : app, null];
    case "downloaded":
      return [{ kind: "ready", version: input.version, notes: notesOf(app) }, app.kind === "available" && app.restart ? "quit-and-install" : null];
    case "error":
      // A background check that fails says nothing: the next one tries again. A download or an asked-for check does.
      if (app.kind === "available") return [{ kind: "failed", during: "download", reason: input.reason }, null];
      return [app.kind === "checking" ? { kind: "failed", during: "check", reason: input.reason } : app, null];
    case "notes":
      return [found(app) ? { ...app, notes: input.notes } : app, null];
    case "install":
      if (app.kind === "ready") return [app, "quit-and-install"];
      if (app.kind === "manual") return [app, "open-download"];
      if (app.kind === "available") return [{ ...app, restart: true }, null];
      return [app, null];
    case "keep":
      return [app.kind === "available" ? { ...app, restart: false } : app, null];
  }
};
