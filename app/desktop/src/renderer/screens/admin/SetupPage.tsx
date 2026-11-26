// Settings › Hub › Setup: what the hub connects to and what it still needs, one page (Hub accounts was a page of its
// own once). The hub's setup steps (setup_list), the same ones `fleetd init` and the first run walk, a row each: its
// accounts first (Claude, GitHub, 1Password), every one always, each row the account's state (what it runs on, when
// it is needed, or that it wants a look); then the other steps still left. A row opens the step in place of the
// list, the way back in the window's top row: for the hub's own accounts that page holds the account's controls
// (the hub's Claude API key, Claude.tsx; its GitHub App, github/AdminGithub.tsx) over the step's guide (its paste
// values, where else its result is saved, its Test). Steps that are done stay in the list as checked rows, to change
// a value or test one. What needs the admin now comes first (setup/steps.ts's setupLayout). The
// open step is this page's own: the route names only the page; a search or a link for an account's option (useWanted)
// opens the account that holds it, and one for Hub accounts lands on the accounts. A hub too old to serve its steps
// still lists its own two accounts, which open their controls.
import { ChevronLeft, Circle, CircleAlert, CircleCheck } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { Person } from "../../../shared/contracts";
import { Text } from "../../ui";
import { Part } from "../settings/Frames";
import { Notice, PageFrame, PageHead, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { revealNext, useWanted } from "../settings/reveal";
import { StepGuide, useSetupSteps } from "../setup/SetupScreen";
import { doneWords, needWords, requiredLeft, setupLayout, type SetupStep } from "../setup/steps";
import { stepControls } from "../setup/accounts";
import { setupGithubReturn } from "../start/kept";
import { MoveRow } from "./MoveToCloud";
import s from "../settings/settings.module.css";

/** The hub's own accounts, whose controls their step's page holds: by the step's id, each with its name. */
const HUB_ACCOUNTS: ReadonlyArray<readonly [id: string, title: string]> = [
  ["claude", "Claude"],
  ["github", "GitHub"],
];
const titleOf = (id: string): string | undefined => HUB_ACCOUNTS.find(([account]) => account === id)?.[1];

/** The account that holds an option a search or a link asks for (settings/search.ts's keys). */
const HOLDS: Readonly<Record<string, string>> = { "admin.claude": "claude", "admin.claude.members": "claude", "admin.github": "github" };

export function SetupPage({ me }: { me: Person | undefined }) {
  const steps = useSetupSteps();
  // Back from GitHub's trip (Connect GitHub, in the web app): its page, which says how it ended.
  const [open, setOpen] = useState<string | null>(() => (setupGithubReturn() === null ? null : "github"));
  const back = useCallback(() => {
    // An option its account's page never showed (a hub that doesn't serve it) stops waiting, or it would open the
    // account again.
    revealNext(null);
    setOpen(null);
  }, []);
  // A newly wanted option opens the account that holds it; Hub accounts, the list.
  const want = useWanted();
  const [seen, setSeen] = useState<string | null>(null);
  if (want !== seen) {
    setSeen(want);
    const account = want === null ? undefined : HOLDS[want];
    if (account !== undefined) setOpen(account);
    else if (want === "hub.accounts") setOpen(null);
  }
  if (steps === null && open === null) {
    return (
      <div className={s.scroll} data-screen="settings.hub.setup.loading">
        <div className={s.column}>
          <PageHead title="Setup">Loading…</PageHead>
        </div>
      </div>
    );
  }
  const list = steps !== null && "steps" in steps ? steps.steps : [];
  if (open !== null) {
    const step = list.find((st) => st.id === open);
    const title = step?.title ?? titleOf(open);
    if (title !== undefined) return <StepPage id={open} title={title} step={step} me={me} onBack={back} />;
  }
  const { accounts, others, done, othersFirst } = setupLayout(list);
  const required = requiredLeft(list);
  const problem = steps !== null && "problem" in steps ? steps : null;
  // One checklist: what needs the admin now first, then the accounts, then what is done, each row a check.
  const ordered = othersFirst ? [...others, ...accounts] : [...accounts, ...others];
  const all = [...ordered, ...done];
  const doneCount = all.filter((st) => st.status === "done").length;
  return (
    <div className={s.scroll} data-screen={problem === null ? "settings.hub.setup" : "settings.hub.setup.error"}>
      <div className={s.column}>
        <PageHead
          title="Setup"
          aside={
            all.length === 0 ? undefined : (
              <Text tone="quiet" data-done={String(done.length)}>
                {doneCount === all.length ? "All set up" : `${String(doneCount)} of ${String(all.length)} done`}
              </Text>
            )
          }
        >
          {problem !== null ? (
            <Text tone={problem.old ? "quiet" : "danger"}>{problem.old ? "This workspace is too old for guided setup. Update fleetd on the workspace first." : problem.problem}</Text>
          ) : null}
        </PageHead>
        {required === 0 ? null : <Notice tone="warning">{`${String(required)} required before agents can run.`}</Notice>}
        <Part reveal="hub.accounts" screen="settings.hub.accounts">
          <SettingsSection>
            <SettingsList label="Steps">
              {all.map((st) => (
                <StepRow key={st.id} step={st} account={accounts.includes(st)} onOpen={() => setOpen(st.id)} />
              ))}
              {/* The hub's own accounts keep their row, and so their controls, whatever the hub's steps say or don't. With
                  no step to say where one stands (fleetd cloud), the row claims nothing: its page says it. */}
              {HUB_ACCOUNTS.filter(([id]) => !list.some((st) => st.id === id)).map(([id, title]) => (
                <SettingsListRow key={id} name={title} label={title} open={{ onClick: () => setOpen(id) }} data={{ "data-step": id }} />
              ))}
            </SettingsList>
          </SettingsSection>
        </Part>
        <MoveRow />
      </div>
    </div>
  );
}

/** A step's state as its check: done, to do, or wanting a look. */
function StepGlyph({ status }: { status: SetupStep["status"] }) {
  return status === "done" ? (
    <CircleCheck data-step-glyph="done" aria-label="Done" />
  ) : status === "look" ? (
    <CircleAlert data-step-glyph="look" aria-label="Needs a look" />
  ) : (
    <Circle data-step-glyph="todo" aria-label="To do" />
  );
}

/**
 * A step as one row: its name, and when it is needed or that it wants a look; an account, always listed, says once it
 * is done what it uses. The row opens it.
 */
function StepRow({ step, account, onOpen }: { step: SetupStep; account: boolean; onOpen: () => void }) {
  return (
    <SettingsListRow
      name={step.title}
      label={step.title}
      icon={<StepGlyph status={step.status} />}
      meta={step.status === "todo" ? needWords(step.need) : account || step.status === "done" ? doneWords(step) : undefined}
      state={step.status === "look" ? { word: "Needs a look", tone: step.failing === true ? "danger" : "warning" } : undefined}
      open={{ onClick: onOpen }}
      data={{ "data-step": step.id, "data-status": step.status }}
    />
  );
}

/**
 * One step, in place of the list: its name and the way back in the window's top row; the hub's account it sets up,
 * its controls, then its guide. Without the step (a hub too old to serve them), the account alone.
 */
function StepPage({ id, title, step, me, onBack }: { id: string; title: string; step: SetupStep | undefined; me: Person | undefined; onBack: () => void }) {
  const frame = useMemo(
    () => ({
      title,
      lead: (
        <button type="button" className={s.back} onClick={onBack}>
          <ChevronLeft aria-hidden />
          Setup
        </button>
      ),
    }),
    [title, onBack],
  );
  const controls = stepControls(id, me);
  return (
    <PageFrame.Provider value={frame}>
      <div className={s.scroll} data-screen="settings.hub.setup.step">
        <div className={s.column}>
          <PageHead title={title} />
          {step === undefined ? (
            controls
          ) : (
            <SettingsSection bare>
              <StepGuide step={step} account={controls} />
            </SettingsSection>
          )}
        </div>
      </div>
    </PageFrame.Provider>
  );
}
