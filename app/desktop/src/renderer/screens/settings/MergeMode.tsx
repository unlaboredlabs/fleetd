// How a bot's PRs merge (its Projects page, Safety, below Who merges): "Test, then merge", the train's batches (the
// default), or "Merge, then verify", each PR on its own green CI with a revert when main goes red (hub train/lanes.ts,
// verify.ts). While it merges, then verifies, a repo whose main requires branches up to date says so in one line: PRs
// still land one at a time there. An admin, where fleetd's GitHub access may, turns that one setting off from here.
// Reads the project's summary (`mergeMode`) and project_settings_get (`upToDate`); writes project_settings_set. Until
// project_settings_get answers, the line this device last showed holds its place, its Turn off off.
import { useEffect, useState } from "react";
import type { MergeMode, UpToDateRule } from "../../../shared/contracts";
import { useAdministers } from "../admin/role";
import { Button, Segmented } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { keep, keptOf } from "./HoldsPlace";
import { HintLines, SettingsRow } from "./parts";
import { MERGE_MODE_WORDS, MERGE_MODES, upToDateText } from "./mergeModeModel";

type Ref = { machineId: string; projectId: string };

const HINT = [
  "How the merge train lands the bot's reviewed PRs.",
  ["Test, then merge", MERGE_MODE_WORDS.test_first],
  ["Merge, then verify", MERGE_MODE_WORDS.verify_after],
] as const;

/** The rule this device last showed under the bot's How it merges, while it still holds; undefined when none. */
function keptRule(id: string): UpToDateRule | undefined {
  const v = keptOf(id) as Partial<UpToDateRule> | null | undefined;
  return v && typeof v.repo === "string" && typeof v.base === "string" && typeof v.line === "string" ? (v as UpToDateRule) : undefined;
}

/** `upToDate` undefined: project_settings_get hasn't answered yet. */
export function MergeModeSetting({ projectRef, mode, upToDate }: { projectRef: Ref; mode: MergeMode; upToDate: readonly UpToDateRule[] | undefined }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const admin = useAdministers();
  const [picked, setPicked] = useState<{ to: MergeMode; over: MergeMode } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  // A pick shows at once, until the hub's own word on it comes back.
  const shown = picked !== null && picked.over === mode ? picked.to : mode;
  const pick = (to: MergeMode) => {
    if (to === shown) return;
    const mine = { to, over: mode };
    setPicked(mine);
    setProblem(null);
    hubCall("project_settings_set", { ...projectRef, mergeMode: to }).then(
      () => refetch(["project_settings_get"]),
      (e: unknown) => {
        setPicked((p) => (p === mine ? null : p));
        setProblem(errorText(e));
      },
    );
  };
  // The first base that holds the PRs to one at a time; the hub only reads them while the bot merges, then verifies.
  const id = `upToDate:${projectRef.machineId}/${projectRef.projectId}`;
  const reading = upToDate === undefined;
  useEffect(() => {
    if (upToDate !== undefined) keep(id, upToDate[0] ?? null);
  }, [id, upToDate]);
  const rule = shown === "verify_after" ? (reading ? keptRule(id) : upToDate[0]) : undefined;
  const turnOff = (repo: string) => {
    setTurningOff(true);
    setProblem(null);
    hubCall("project_settings_set", { ...projectRef, upToDateOff: repo }).then(
      () => {
        setTurningOff(false);
        refetch(["project_settings_get"]);
      },
      (e: unknown) => {
        setTurningOff(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <SettingsRow
      reveal="projects.merge_mode"
      title="How it merges"
      hint={<HintLines lines={HINT} />}
      line={problem ?? (rule === undefined ? undefined : upToDateText(rule, admin))}
      lineTone={problem !== null ? "danger" : "warning"}
      lineAction={
        problem === null && rule !== undefined && rule.canTurnOff && admin ? (
          <Button variant="ghost" disabled={!live || turningOff || reading} onClick={() => turnOff(rule.repo)}>
            {turningOff ? "Turning off…" : "Turn off"}
          </Button>
        ) : undefined
      }
      control={<Segmented label="How it merges" options={MERGE_MODES} value={shown} disabled={!live} onChange={pick} />}
    />
  );
}
