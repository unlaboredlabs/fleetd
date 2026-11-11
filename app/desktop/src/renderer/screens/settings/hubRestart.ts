// Settings › You › Hubs & devices › Restart hub: an admin's restart of the hub in scope (hub_restart), and what its row says
// while it goes: asked, the hub away, back. The hub answers before it stops; a call the restart itself cut off counts
// as answered.
import { useEffect, useRef, useState } from "react";
import type { HubError } from "../../../shared/hub";
import { lacksTool } from "../../src/data/errors";
import { useDataLayer } from "../../src/data/react";

/** How long a hub that took the restart may stay up before the row says it didn't restart. */
export const RESTART_WAIT_MS = 20_000;

export type RestartStep =
  | { readonly at: "idle" }
  | { readonly at: "asking" }
  /** The hub took it: `leads` of its leads start again on the current lead profile once it is back. */
  | { readonly at: "restarting"; readonly leads: number }
  | { readonly at: "done"; readonly leads: number }
  | { readonly at: "failed"; readonly message: string; readonly fix?: string | undefined };

/** A call that ended because the hub went away: the restart it asked for. */
const cutOff = (error: HubError): boolean => error.code === "disconnected";

/** What the hub's row says of a restart: null when there is nothing to say. */
export function restartLine(step: RestartStep): { tone: "quiet" | "success" | "danger"; text: string } | null {
  switch (step.at) {
    case "idle":
      return null;
    case "asking":
    case "restarting":
      return { tone: "quiet", text: "Restarting the hub…" };
    case "done":
      return {
        tone: "success",
        text:
          step.leads === 0
            ? "Restarted. Connected."
            : `Restarted. Connected. ${step.leads === 1 ? "1 lead starts" : `${step.leads} leads start`} again on the current lead profile, each once it is idle.`,
      };
    case "failed":
      return { tone: "danger", text: `${step.message}${step.fix === undefined ? "" : ` ${step.fix}`}` };
  }
}

/** The restart of the hub in scope: its step, and `restart` to ask for it. */
export function useHubRestart(): { step: RestartStep; restart: () => void } {
  const layer = useDataLayer();
  const [step, setStep] = useState<RestartStep>({ at: "idle" });
  // Whether the hub has been away since the restart was asked for.
  const away = useRef(false);
  const busy = step.at === "asking" || step.at === "restarting";
  const restarting = step.at === "restarting";
  useEffect(() => {
    if (!busy) return;
    // The store itself, not a render's view of it: the hub is away for well under a second.
    return layer.store.subscribe((s) => {
      if (s.hub.phase !== "live") away.current = true;
      else if (away.current) setStep((was) => (was.at === "restarting" ? { at: "done", leads: was.leads } : was));
    });
  }, [busy, layer]);
  useEffect(() => {
    if (!restarting) return;
    // Away and back already, before its answer was read.
    if (away.current && layer.store.getState().hub.phase === "live") {
      setStep((was) => (was.at === "restarting" ? { at: "done", leads: was.leads } : was));
      return;
    }
    const late = setTimeout(() => {
      if (!away.current) setStep({ at: "failed", message: "The hub took the restart but is still up.", fix: "Try again, or restart its service on the hub's machine." });
    }, RESTART_WAIT_MS);
    return () => clearTimeout(late);
  }, [restarting, layer]);
  const restart = () => {
    if (busy) return;
    away.current = false;
    setStep({ at: "asking" });
    void layer.call("hub_restart", {}).then((out) => {
      if (out.ok) setStep({ at: "restarting", leads: out.output.leads });
      else if (cutOff(out.error)) {
        away.current = true;
        setStep({ at: "restarting", leads: 0 });
      } else if (lacksTool(out.error)) setStep({ at: "failed", message: "This hub runs a fleetd from before Restart hub.", fix: "Update fleetd on it first." });
      else setStep({ at: "failed", message: out.error.message, fix: out.error.fix });
    });
  };
  return { step, restart };
}
