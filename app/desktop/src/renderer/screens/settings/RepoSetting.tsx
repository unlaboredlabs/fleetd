// Settings › Projects › Project › Code: the git repos a project holds (ProjectSummary.repos), each with its remote, base
// branch and checkout; then each repo's Setup in a section of its own (SetupSetting.tsx). Add a repo (the plus) takes a
// checkout on the project's machine or a GitHub repo to clone there (project_repo_add); Remove takes one out
// (project_repo_remove), ending its agents and leaving its files. A plain folder holds none until one is added.
import { GitBranch } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Dialog, Input, Text } from "../../ui";
import type { ProjectRepo, ProjectSettings as Settings, ProjectSummary } from "../../../shared/contracts";
import { useData } from "../../src/data/react";
import { repoName } from "../factory/model";
import { errorText, useHubCall, useLive } from "./hub";
import { AddButton, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects } from "./parts";
import { RepoSetup, Setup } from "./SetupSetting";
import { addInput, checkoutPath, isOwn, sourceProblem } from "./repoModel";
import s from "./settings.module.css";

type Echo = { ok: boolean; text: string };

/**
 * A project's Code section: its repos, a plus to add one, then what `children` adds (its environment variables); and
 * each repo's Setup, in a section of its own under it: the project's own directory's first, while it is one of them (a
 * project's own repo is listed from its first agent on).
 */
export function RepoSection({ settings, children }: { settings: Settings; children?: ReactNode }) {
  const projects = useProjects() ?? [];
  const repos = projects.find((p) => p.machineId === settings.machineId && p.projectId === settings.projectId)?.repos ?? [];
  const [echo, setEcho] = useState<Echo | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectRepo | null>(null);
  const own = repos.find((r) => isOwn(r, settings));
  const others = repos.filter((r) => !isOwn(r, settings));
  return (
    <>
      <SettingsSection title="Code">
        <SettingsRow
          reveal="projects.repos"
          title="Repos"
          line={repos.length === 0 ? "No repo, a plain folder." : "The git repos the project holds."}
          control={adding ? undefined : <AddButton label="Add a repo" onClick={() => setAdding(true)} />}
        >
          {repos.length === 0 ? null : (
            <SettingsList label="Repos">
              {repos.map((repo) => (
                <RepoRow key={repo.repoId} repo={repo} projects={projects} onRemove={isOwn(repo, settings) ? null : () => setRemoving(repo)} />
              ))}
            </SettingsList>
          )}
          {adding ? <AddRepo settings={settings} onCancel={() => setAdding(false)} onDone={setEcho} /> : null}
          {echo ? (
            <div role={echo.ok ? "status" : "alert"}>
              <Text size="sm" tone={echo.ok ? "quiet" : "danger"}>
                {echo.text}
              </Text>
            </div>
          ) : null}
        </SettingsRow>
        {children}
      </SettingsSection>
      {own !== undefined || others.length === 0 ? (
        <Setup settings={settings} title={others.length === 0 ? "Setup" : `Setup: ${own?.name ?? settings.title}`} reveal="projects.setup" />
      ) : null}
      {others.map((repo) => (
        <RepoSetup key={repo.repoId} settings={settings} repo={repo.name} />
      ))}
      <RemoveRepoDialog
        repo={removing}
        settings={settings}
        projects={projects}
        onClose={() => setRemoving(null)}
        onDone={(text) => {
          setRemoving(null);
          setEcho({ ok: true, text });
        }}
      />
    </>
  );
}

/** A path on the project's machine or a GitHub repo, and an optional name; a clone shows here once it lands. */
function AddRepo({ settings, onCancel, onDone }: { settings: Settings; onCancel: () => void; onDone: (echo: Echo) => void }) {
  const hubCall = useHubCall();
  const live = useLive();
  const machine = useData((d) => d.machines[settings.machineId]?.name) ?? settings.machineId;
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const input = addInput(settings, source, name);
  const problem = sourceProblem(source);
  const add = () => {
    if (input === null) return;
    setBusy(true);
    hubCall("project_repo_add", input).then(
      (out) => {
        setBusy(false);
        setSource("");
        setName("");
        onDone({ ok: true, text: out.addId ? `Cloning into ${out.path} on ${machine}; it shows here once the clone ends.` : (out.next ?? "Added.") });
      },
      (e: unknown) => {
        setBusy(false);
        onDone({ ok: false, text: errorText(e) });
      },
    );
  };
  // Add repo says why it can't be used yet, under its fields.
  const why = !live ? "Connect to the hub to add a repo." : (problem ?? (input === null ? `Type a checkout on ${machine}, or a GitHub URL.` : `Added to the project on ${machine}.`));
  return (
    <div className={s.addRepo} role="group" aria-label="Add a repo">
      <div className={s.inline}>
        <Input
          aria-label="Repo to add"
          className={s.grow}
          autoFocus
          placeholder={`A checkout on ${machine}, or a GitHub URL`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <Input aria-label="Repo name" placeholder="Name (optional)" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!live || busy || input === null} onClick={add}>
          {busy ? "Adding…" : "Add repo"}
        </Button>
      </div>
      <Text size="sm" tone="quiet">
        {why}
      </Text>
    </div>
  );
}

function RemoveRepoDialog(props: {
  repo: ProjectRepo | null;
  settings: Settings;
  projects: ReadonlyArray<ProjectSummary>;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const hubCall = useHubCall();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const repo = props.repo;
  const remove = () => {
    if (repo === null) return;
    setBusy(true);
    setProblem(null);
    hubCall("project_repo_remove", { machineId: props.settings.machineId, projectId: props.settings.projectId, name: repo.name }).then(
      (out) => {
        setBusy(false);
        props.onDone(`${repo.name} removed. ${out.next ?? ""}`.trim());
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <Dialog
      open={repo !== null}
      onOpenChange={(open) => !open && props.onClose()}
      title={repo ? `Remove ${repo.name} from ${props.settings.title}?` : ""}
      description={repo ? `Its agents stop. Its checkout stays at ${checkoutPath(repo, props.projects)}, files and all.` : ""}
      footer={
        <>
          <Button onClick={props.onClose}>Keep it</Button>
          <Button variant="danger" disabled={busy} onClick={remove}>
            {busy ? "Removing…" : "Remove repo"}
          </Button>
        </>
      }
    >
      {problem ? (
        <div role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      ) : null}
    </Dialog>
  );
}

function RepoRow({ repo, projects, onRemove }: { repo: ProjectRepo; projects: ReadonlyArray<ProjectSummary>; onRemove: (() => void) | null }) {
  const machine = useData((d) => d.machines[repo.checkout.machineId]?.name) ?? repo.checkout.machineId;
  return (
    <SettingsListRow
      label={repo.name}
      icon={<GitBranch />}
      name={repo.name}
      controls={
        onRemove ? (
          <Button variant="ghost" onClick={onRemove}>
            Remove…
          </Button>
        ) : undefined
      }
    >
      <dl className={s.repoFacts}>
        <Fact label="Remote">{repo.repoKey ? <Text size="sm" mono>{repoName(repo.repoKey)}</Text> : <Quiet>None</Quiet>}</Fact>
        <Fact label="Base branch">{repo.base ? <Text size="sm" mono>{repo.base}</Text> : <Quiet>Not known yet</Quiet>}</Fact>
        <Fact label="Checkout">
          <Text size="sm">
            <code>{checkoutPath(repo, projects)}</code> on {machine}
          </Text>
        </Fact>
      </dl>
    </SettingsListRow>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>
        <Text size="sm" tone="quiet">
          {label}
        </Text>
      </dt>
      <dd>{children}</dd>
    </>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" tone="quiet">
      {children}
    </Text>
  );
}
