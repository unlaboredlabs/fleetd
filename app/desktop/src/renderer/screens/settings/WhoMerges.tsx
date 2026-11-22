// A bot's Who merges (its Projects page, Safety): You, people merging its PRs on GitHub (a new bot's default), or
// fleetd's merge train. While You, Rules opens its risk rules below the row: the files whose PRs merge themselves
// all the same, and those that always wait for a person, one rule a line. The hub enforces both in its train.
// Reads the project's summary (`merges`) and project_settings_get (`mergeRules`); writes project_settings_set.
import { useState } from "react";
import type { Merger, RiskRules } from "../../../shared/contracts";
import { Button, Segmented, Text, Textarea } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { HintLines, SettingsRow } from "./parts";
import { linesOf, RULES_WORDS, rulesText, WHO_MERGES, WHO_MERGES_WORDS } from "./whoMergesModel";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

const HINT = [
  "Who merges the bot's PRs once they are reviewed and green.",
  ["You", WHO_MERGES_WORDS.people],
  ["fleetd", WHO_MERGES_WORDS.fleetd],
  ["Rules", RULES_WORDS],
] as const;

export function WhoMergesSetting({ projectRef, merges, rules }: { projectRef: Ref; merges: Merger; rules: RiskRules | undefined }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [picked, setPicked] = useState<{ to: Merger; over: Merger } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // A pick shows at once, until the hub's own word on it comes back.
  const shown = picked !== null && picked.over === merges ? picked.to : merges;
  const pick = (to: Merger) => {
    if (to === shown) return;
    const mine = { to, over: merges };
    setPicked(mine);
    setProblem(null);
    hubCall("project_settings_set", { ...projectRef, merges: to }).then(
      () => refetch(["project_settings_get"]),
      (e: unknown) => {
        setPicked((p) => (p === mine ? null : p));
        setProblem(errorText(e));
      },
    );
  };
  const people = shown === "people";
  return (
    <SettingsRow
      reveal="projects.merges"
      title="Who merges"
      hint={<HintLines lines={HINT} />}
      line={problem}
      lineTone="danger"
      control={
        <>
          {people && rules !== undefined ? (
            <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
              Rules
            </Button>
          ) : null}
          <Segmented label="Who merges" options={WHO_MERGES} value={shown} disabled={!live} onChange={pick} />
        </>
      }
    >
      {people && open && rules !== undefined ? <RulesEditor key={rulesText(rules.itself) + rulesText(rules.person)} projectRef={projectRef} rules={rules} /> : null}
    </SettingsRow>
  );
}

/** The two lists of rules, one a line, saved together. */
function RulesEditor({ projectRef, rules }: { projectRef: Ref; rules: RiskRules }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [itself, setItself] = useState(rulesText(rules.itself));
  const [person, setPerson] = useState(rulesText(rules.person));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dirty = itself !== rulesText(rules.itself) || person !== rulesText(rules.person);
  const save = () => {
    setBusy(true);
    setProblem(null);
    hubCall("project_settings_set", { ...projectRef, mergeRules: { itself: linesOf(itself), person: linesOf(person) } }).then(
      () => {
        setBusy(false);
        refetch(["project_settings_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <div className={s.stack}>
      <label className={s.stack}>
        <Text size="sm">Merges itself when every file matches</Text>
        <Textarea mono aria-label="Merges itself" value={itself} minRows={3} maxRows={12} onChange={(e) => setItself(e.target.value)} />
      </label>
      <label className={s.stack}>
        <Text size="sm">Always waits for a person when any file matches</Text>
        <Textarea mono aria-label="Always a person" value={person} minRows={3} maxRows={12} onChange={(e) => setPerson(e.target.value)} />
      </label>
      {problem === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      )}
      {dirty ? (
        <div className={s.inline}>
          <Button variant="primary" disabled={!live || busy} onClick={save}>
            {busy ? "Saving…" : "Save rules"}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setItself(rulesText(rules.itself));
              setPerson(rulesText(rules.person));
              setProblem(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
