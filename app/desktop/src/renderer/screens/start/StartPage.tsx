// Get started (model.ts): one page, the bot and a title where sign-in left them, then the few steps still between the
// person and a first chat with a bot's lead. The step open now is the page's one soft group; a step done is its title and
// what it ended on, one still to come its title alone. Nothing to read at rest but the open step's own words, and a
// command only where nothing else can do it (a computer joining). Skip for now goes to the app; the You menu keeps a
// quiet Finish setting up until no step is left.
import { Check, Plus, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Bot, Button, copyText, cx, Input, Segmented, StateGlyph, Text } from "../../ui";
import { botOf, currentStep, matching, stepDone, stepsOf, type ComputerStep, type GithubStep, type ProjectStep, type StartView, type StepId, type TeamProject } from "./model";
import s from "./start.module.css";

export interface StartActions {
  readonly onCopy?: (line: string) => void;
  readonly onClaudeLogin?: () => void;
  readonly onClaudeCode?: (code: string) => void;
  /** Settings › Your accounts › Claude: the account hosted sandboxes' agents run on. */
  readonly onClaudeAccount?: () => void;
  readonly onGithub?: () => void;
  readonly onGithubSkip?: () => void;
  /** GitHub's install page again, to choose the repositories fleetd's App reaches. */
  readonly onGithubRepos?: () => void;
  readonly onQuery?: (query: string) => void;
  readonly onRepo?: (owner: string, name: string) => void;
  readonly onEmpty?: () => void;
  readonly onOpen?: (project: string) => void;
  readonly onSkip?: () => void;
}

const TITLES: Record<StepId, string> = { computer: "Where agents run", github: "Connect GitHub", project: "Start a bot" };

/** `hosted`: the team's hosted sandbox providers as rows to connect (settings/Providers), the second way agents run. */
export function StartPage({ view, actions = {}, hosted }: { view: StartView; actions?: StartActions; hosted?: ReactNode }) {
  const open = currentStep(view);
  const steps = stepsOf(view);
  return (
    <div className={s.screen} data-screen={`start.${open}`}>
      <div className={s.column}>
        <div className={s.head}>
          <Bot state={botOf(view)} size={64} />
          <Text as="h1" size="xl" strong className={s.title}>
            {view.who === "owner" ? "Get started" : `Welcome to ${view.team}`}
          </Text>
        </div>
        <ol className={s.steps}>
          {steps.map((step, i) => (
            <Step key={step} n={i + 1} id={step} view={view} open={step === open} actions={actions} hosted={hosted} />
          ))}
        </ol>
        {/* Either way on is the app as it is, set up later: the You menu's Finish setting up comes back here. */}
        <div className={s.foot}>
          <Button variant="quiet" onClick={actions.onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, id, view, open, actions, hosted }: { n: number; id: StepId; view: StartView; open: boolean; actions: StartActions; hosted: ReactNode }) {
  // A skipped GitHub lets the steps go on, but it isn't done: it keeps its number, its Connect at its end.
  const done = stepDone(view, id) && !(id === "github" && (view.github.at === "skipped" || view.github.at === "requested"));
  const title = id === "project" && view.who === "teammate" ? "Open a bot" : TITLES[id];
  return (
    <li className={cx(s.step, open && s.open)} data-step={id} aria-current={open ? "step" : undefined}>
      <div className={s.stepHead}>
        <span className={cx(s.mark, done && s.markDone, open && s.markOpen)} aria-hidden>
          {done ? <Check size={12} strokeWidth={2.5} /> : n}
        </span>
        <Text strong={open} tone={done || open ? "default" : "quiet"} className={s.stepTitle}>
          {title}
        </Text>
        {!open ? <Ended id={id} view={view} actions={actions} /> : null}
      </div>
      {open ? <div className={s.body}>{body(id, view, actions, hosted)}</div> : null}
    </li>
  );
}

/** What a step done ended on, quiet at its row's end. */
function Ended({ id, view, actions }: { id: StepId; view: StartView; actions: StartActions }) {
  if (id === "computer" && view.who === "owner" && view.computer.at === "ready") return <Text tone="quiet">{view.computer.machine}</Text>;
  if (id === "computer" && view.who === "owner" && view.computer.at === "hosted") return <Text tone="quiet">{view.computer.provider}</Text>;
  if (id === "github" && view.github.at === "done") return <Text tone="quiet">{view.github.login}</Text>;
  if (id === "project" && view.who === "owner" && view.project.at === "made") return <Text tone="quiet">{view.project.name}</Text>;
  if (id === "github" && view.github.at === "requested") return <Text tone="quiet">Asked an owner on GitHub</Text>;
  if (id === "github" && view.who === "teammate" && view.github.at === "todo") {
    return (
      <Button icon={<GithubMark />} onClick={actions.onGithub}>
        Connect
      </Button>
    );
  }
  if (id === "github" && view.who === "teammate" && view.github.at === "waiting") return <Text tone="quiet">Opening GitHub…</Text>;
  if (id === "github" && view.github.at === "skipped") {
    return (
      <Button variant="quiet" className={s.end} onClick={actions.onGithub}>
        Connect
      </Button>
    );
  }
  return null;
}

function body(id: StepId, view: StartView, actions: StartActions, hosted: ReactNode): ReactNode {
  if (id === "computer" && view.who === "owner") return <Computer step={view.computer} actions={actions} hosted={hosted} />;
  if (id === "github") return <Github step={view.github} actions={actions} />;
  if (view.who === "owner") return <Project step={view.project} skipped={view.github.at !== "done"} actions={actions} />;
  return <Projects projects={view.projects} actions={actions} />;
}

/** Where agents run, while nothing runs them yet: a computer (its join line) or a hosted provider (its rows). */
function Where({ step, actions, hosted }: { step: Extract<ComputerStep, { at: "line" }>; actions: StartActions; hosted: ReactNode }) {
  const [way, setWay] = useState<"computer" | "hosted">("computer");
  return (
    <>
      {hosted ? (
        <Segmented
          label="Where agents run"
          options={[
            { value: "computer", label: "A computer" },
            { value: "hosted", label: "Hosted sandboxes" },
          ]}
          value={way}
          onChange={setWay}
        />
      ) : null}
      {way === "hosted" && hosted ? <div className={s.hosted}>{hosted}</div> : <Computer step={step} actions={actions} hosted={null} />}
    </>
  );
}

function Computer({ step, actions, hosted }: { step: ComputerStep; actions: StartActions; hosted: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  if (step.at === "line" && hosted) return <Where step={step} actions={actions} hosted={hosted} />;
  if (step.at === "hosted_wait") return <Waiting>{`Getting ${step.provider}'s sandboxes ready`}</Waiting>;
  if (step.at === "hosted_claude") {
    // Agents in sandboxes run on the team's Claude account: no computer's login reaches them.
    return (
      <>
        <div className={s.joined}>
          <Check size={14} strokeWidth={2.5} className={s.ok} aria-hidden />
          <Text>{`${step.provider} is connected`}</Text>
        </div>
        <Text as="p" tone="quiet">
          Connect Claude, so its agents can work.
        </Text>
        <div className={s.actions}>
          <Button variant="primary" size="md" onClick={actions.onClaudeAccount}>
            Connect Claude
          </Button>
        </div>
      </>
    );
  }
  if (step.at === "line") {
    const { line } = step;
    return (
      <>
        <Text as="p" tone="quiet">
          Paste this in a terminal on a Mac or Linux computer.
        </Text>
        {line !== null ? (
          <>
            <div className={s.line}>
              {/* Each word whole on its line: the command breaks only between its words, never inside a flag. */}
              <code className={s.lineText}>
                {line.split(" ").map((word, i) => (
                  <span key={i}>
                    {i === 0 ? null : " "}
                    <span className={s.word}>{word}</span>
                  </span>
                ))}
              </code>
              <Button
                onClick={() => {
                  actions.onCopy?.(line);
                  void copyText(line).then(setCopied);
                }}
                onBlur={() => setCopied(false)}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Waiting>Waiting for it to connect</Waiting>
          </>
        ) : step.error === undefined ? (
          <Waiting>Making a line</Waiting>
        ) : (
          <span role="alert">
            <Text size="sm" tone="danger">
              {step.error}
            </Text>
          </span>
        )}
      </>
    );
  }
  if (step.at === "ready" || step.at === "hosted") return null;
  const joined = (
    <div className={s.joined}>
      <Check size={14} strokeWidth={2.5} className={s.ok} aria-hidden />
      <Text>{`${step.machine} is connected`}</Text>
    </div>
  );
  if (step.at === "offline") {
    // Joined before and off now: nothing to do here but turn it on, or start fleetd there again.
    return (
      <>
        <span role="status">
          <Text tone="warning">{`${step.machine} is offline. Turn it on, or start fleetd on it.`}</Text>
        </span>
        <Waiting>{`Waiting for ${step.machine}`}</Waiting>
      </>
    );
  }
  if (step.at === "unusable") {
    // Agents can't run there yet: the hub's own words, with their fix; the step goes on once the machine is well.
    return (
      <>
        {joined}
        <span role="status">
          <Text tone="warning">{step.reason}</Text>
        </span>
        <Waiting>{`Waiting for ${step.machine} to be ready`}</Waiting>
      </>
    );
  }
  return (
    <>
      {joined}
      {step.login === "start" || step.login === "starting" ? (
        <>
          <Text as="p" tone="quiet">
            {`Log in to Claude on ${step.machine}, so its agents can work.`}
          </Text>
          {step.error === undefined ? null : (
            <span role="alert">
              <Text size="sm" tone="danger">
                {step.error}
              </Text>
            </span>
          )}
          <div className={s.actions}>
            <Button variant="primary" size="md" disabled={step.login === "starting"} onClick={actions.onClaudeLogin}>
              {step.login === "starting" ? "Opening Claude…" : "Log in to Claude"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Text as="p" tone="quiet">
            {step.opened === false ? "The browser didn't open Claude's sign-in page. Open it, sign in, then paste the code it shows." : "Sign in on the page that opened, then paste the code it shows."}
          </Text>
          <form
            className={s.codeRow}
            onSubmit={(e) => {
              e.preventDefault();
              actions.onClaudeCode?.(code);
            }}
          >
            <Input mono aria-label="Code from Claude" placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
            <Button type="submit" variant="primary" size="md" disabled={step.login === "checking"}>
              {step.login === "checking" ? "Logging in…" : "Log in"}
            </Button>
          </form>
          <div>
            <Button variant="link" className={s.again} onClick={actions.onClaudeLogin}>
              {step.opened === false ? "Open the sign-in page" : "Open the page again"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function Github({ step, actions }: { step: GithubStep; actions: StartActions }) {
  // This tab leaves for GitHub's page and comes back here: the button says so while it goes.
  const going = step.at === "waiting";
  return (
    <>
      <Text as="p" tone="quiet">
        Choose the repositories fleetd may work on.
      </Text>
      {step.at === "todo" && step.error !== undefined ? (
        <span role="alert">
          <Text size="sm" tone="danger">
            {step.error}
          </Text>
        </span>
      ) : null}
      <div className={s.actions}>
        <Button variant="primary" size="md" icon={<GithubMark />} disabled={going} onClick={actions.onGithub}>
          {going ? "Opening GitHub…" : "Connect GitHub"}
        </Button>
        <Button variant="quiet" size="md" disabled={going} onClick={actions.onGithubSkip}>
          Skip
        </Button>
      </div>
    </>
  );
}

function Project({ step, skipped, actions }: { step: ProjectStep; skipped: boolean; actions: StartActions }) {
  if (step.at === "adding") {
    return <Waiting glyph="working">{`Adding ${step.what} on ${step.machine}`}</Waiting>;
  }
  if (step.at === "made") return null;
  const shown = matching(step.repos, step.query).slice(0, 6);
  return (
    <>
      {skipped || step.repos.length <= 6 ? null : (
        <label className={s.find}>
          <Search size={14} aria-hidden />
          <Input placeholder="Find a repository" aria-label="Find a repository" value={step.query} onChange={(e) => actions.onQuery?.(e.target.value)} autoComplete="off" />
        </label>
      )}
      {skipped ? null : step.loading === true ? (
        <Waiting>Reading your repositories</Waiting>
      ) : step.problem !== undefined ? (
        <span role="alert">
          <Text size="sm" tone="danger">
            {step.problem}
          </Text>
        </span>
      ) : step.none === true ? (
        <div className={s.none}>
          <Text tone="quiet">fleetd&apos;s GitHub App reaches no repositories yet.</Text>
          <Button variant="link" onClick={actions.onGithubRepos}>
            Choose repositories
          </Button>
        </div>
      ) : null}
      <ul className={s.list}>
        {skipped
          ? null
          : shown.map((r) => (
              <li key={`${r.owner}/${r.name}`}>
                <button type="button" className={s.row} onClick={() => actions.onRepo?.(r.owner, r.name)}>
                  <span className={s.repo}>
                    <span className={s.owner}>{`${r.owner}/`}</span>
                    {r.name}
                  </span>
                  <Text size="xs" tone="quiet" tabular>
                    {r.pushed}
                  </Text>
                </button>
              </li>
            ))}
        <li>
          <button type="button" className={s.row} onClick={actions.onEmpty}>
            <span className={s.empty}>
              <Plus size={14} aria-hidden />
              Empty bot
            </span>
          </button>
        </li>
      </ul>
      {skipped || step.truncated !== true ? null : (
        <Text as="p" size="sm" tone="quiet">
          Only your most recently pushed repositories are listed.
        </Text>
      )}
    </>
  );
}

function Projects({ projects, actions }: { projects: readonly TeamProject[]; actions: StartActions }) {
  return (
    <ul className={s.list}>
      {projects.length === 0 ? (
        <li>
          <button type="button" className={s.row} onClick={actions.onEmpty}>
            <span className={s.empty}>
              <Plus size={14} aria-hidden />
              New bot
            </span>
          </button>
        </li>
      ) : null}
      {projects.map((p) => (
        <li key={p.key}>
          <button type="button" className={cx(s.row, s.projectRow)} onClick={() => actions.onOpen?.(p.key)}>
            <Bot state={p.busy ? "working" : "idle"} size={24} />
            <span className={s.projectName}>{p.name}</span>
            <Text size="xs" tone="quiet">
              {p.line}
            </Text>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** What the page waits on: the walking ring and its words, quiet. */
function Waiting({ children, glyph = "thinking" }: { children: string; glyph?: "thinking" | "working" }) {
  return (
    <div className={s.waiting} role="status">
      <StateGlyph state={glyph} />
      <Text tone="quiet">{children}</Text>
    </div>
  );
}

/** GitHub's mark, as GitHub gives it, in the button's own colour. */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
