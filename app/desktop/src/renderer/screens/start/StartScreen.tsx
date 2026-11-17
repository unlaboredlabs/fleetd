// #/start: Get started. Phase 1 of its design shows only its sample views (`#/start?sample=<name>`, the QA screens);
// any other opening goes home until it reads the hub's own state (model.ts says from what).
import { useEffect } from "react";
import { navigate } from "../shell/navigation";
import { HOME } from "../shell/routes";
import { isSample, SAMPLES } from "./samples";
import { StartPage } from "./StartPage";

export function StartScreen({ sample }: { sample: string | null }) {
  const known = sample !== null && isSample(sample);
  useEffect(() => {
    if (!known) navigate(HOME);
  }, [known]);
  return known ? <StartPage view={SAMPLES[sample]} actions={{ onSkip: () => navigate(HOME) }} /> : null;
}
