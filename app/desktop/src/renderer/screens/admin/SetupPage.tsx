// Settings › Hub › Setup: what the hub connects to and what it still needs, one page (Hub accounts was a page of its
// own once). The hub's setup steps (setup_list), the same ones `fleetd init` and the first run walk, a row each: its
// accounts first (Claude, GitHub, 1Password), every one always, each row the account's state (what it runs on, when
// it is needed, or that it wants a look); then the other steps still left. A row opens the step in place of the
// list, the way back in the window's top row: for the hub's own accounts that page holds the account's controls
// (the hub's Claude API key, Claude.tsx; its GitHub App, github/AdminGithub.tsx) over the step's guide (its paste
// values, where else its result is saved, its Test). Other steps that are done fold into one quiet line, which shows
// them again to change a value or test one. What needs the admin now comes first (setup/steps.ts's setupLayout). The
// open step is this page's own: the route names only the page; a search or a link for an account's option (useWanted)
// opens the account that holds it, and one for Hub accounts lands on the accounts. A hub too old to serve its steps
// still lists its own two accounts, which open their controls.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { Person } from "../../../shared/contracts";
import { Button, Text } from "../../ui";
import { AdminGithub } from "../github/AdminGithub";
import { Part } from "../settings/Frames";
import { PageFrame, PageHead, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { revealNext, useWanted } from "../settings/reveal";
import { StepGuide, useSetupSteps } from "../setup/SetupScreen";
import { doneWords, needWords, requiredLeft, setupLayout, type SetupStep } from "../setup/steps";
import { ClaudeAdmin } from "./Claude";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

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
  const [open, setOpen] = useState<string | null>(null);
  const [folded, setFolded] = useState(true);
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
  const rows = (of: ReadonlyArray<SetupStep>, account = false) => of.map((st) => <StepRow key={st.id} step={st} account={account} onOpen={() => setOpen(st.id)} />);
  const problem = steps !== null && "problem" in steps ? steps : null;
  const accountsPart = (
    <Part key="accounts" reveal="hub.accounts" screen="settings.hub.accounts">
      <SettingsSection title="Accounts">
        <SettingsList label="Accounts">
          {rows(accounts, true)}
          {/* The hub's own accounts keep their row, and so their controls, whatever the hub's steps say or don't. */}
          {HUB_ACCOUNTS.filter(([id]) => !list.some((st) => st.id === id)).map(([id, title]) => (
            <SettingsListRow key={id} name={title} label={title} open={{ onClick: () => setOpen(id) }} data={{ "data-step": id }} />
          ))}
        </SettingsList>
      </SettingsSection>
    </Part>
  );
  const othersPart =
    others.length === 0 ? null : (
      <SettingsSection key="others" title="This hub">
        <SettingsList label="Steps left">{rows(others)}</SettingsList>
      </SettingsSection>
    );
  return (
    <div className={s.scroll} data-screen={problem === null ? "settings.hub.setup" : "settings.hub.setup.error"}>
      <div className={s.column}>
        <PageHead title="Setup">
          {problem !== null ? (
            <Text tone={problem.old ? "quiet" : "danger"}>{problem.old ? "This hub is too old for guided setup. Update fleetd on the hub first." : problem.problem}</Text>
          ) : required === 0 ? null : (
            `${required} required before agents can run.`
          )}
        </PageHead>
        {othersFirst ? [othersPart, accountsPart] : [accountsPart, othersPart]}
        {done.length === 0 ? null : (
          <SettingsSection
            data={{ "data-done": String(done.length) }}
            intro={
              <span className={a.doneLine}>
                {list.every((st) => st.status === "done") ? "Everything is set up." : `${done.length} done.`}
                <Button variant="link" size="sm" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
                  {folded ? "Show steps" : "Hide steps"}
                </Button>
              </span>
            }
          >
            {folded ? null : <SettingsList label="Steps done">{rows(done)}</SettingsList>}
          </SettingsSection>
        )}
      </div>
    </div>
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
      meta={step.status === "todo" ? needWords(step.need) : account ? doneWords(step) : undefined}
      state={step.status === "look" ? { word: "Needs a look", tone: step.failing === true ? "danger" : "warning" } : undefined}
      open={{ onClick: onOpen }}
      data={{ "data-step": step.id, "data-status": step.status }}
    />
  );
}

/** The controls of one of the hub's own accounts. */
function account(id: string, me: Person | undefined): ReactNode {
  return id === "claude" ? <ClaudeAdmin me={me} /> : id === "github" ? <AdminGithub /> : undefined;
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
        <Button variant="ghost" size="sm" onClick={onBack}>
          ‹ Setup
        </Button>
      ),
    }),
    [title, onBack],
  );
  const controls = account(id, me);
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
