// #/start: Get started, on a fleetd cloud team in the web app, from the team's own state (state.ts); `?sample=<name>`
// shows one of its sample views instead (the QA screens). Anywhere else (the desktop, a self-hosted hub) it goes home,
// and so does an owner's page once nothing is left: their first bot's chat is home.
import { useEffect } from "react";
import { useHub } from "../../src/data/react";
import { onWeb } from "../../src/web";
import { useAddUi } from "../projects/store";
import { navigate } from "../shell/navigation";
import { HOME } from "../shell/routes";
import { stepsLeft } from "./model";
import { isSample, SAMPLES } from "./samples";
import { StartPage } from "./StartPage";
import { useStart } from "./state";

export function StartScreen({ sample }: { sample: string | null }) {
  if (sample !== null && isSample(sample)) return <StartPage view={SAMPLES[sample]} actions={{ onSkip: () => navigate(HOME) }} />;
  return <Live />;
}

function Live() {
  const hub = useHub();
  const { view, actions } = useStart(true, useAddUi());
  const away = !onWeb() || hub.cloud !== true || (view !== null && view.who === "owner" && stepsLeft(view) === 0);
  useEffect(() => {
    if (away) navigate({ ...HOME, at: hub.id }, { replace: true });
  }, [away, hub.id]);
  return view === null || away ? null : <StartPage view={view} actions={actions} />;
}
