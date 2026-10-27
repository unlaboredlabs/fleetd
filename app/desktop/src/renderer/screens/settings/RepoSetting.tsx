// Settings → Projects → Repos: the git repos a project holds (ProjectSummary.repos), each with its remote, base
// branch, checkout, and the setup and preview it runs with, read with project_settings_get and `repo`. Add repo takes a
// checkout on the project's machine or a GitHub repo to clone there (project_repo_add); Remove takes one out
// (project_repo_remove), ending its agents and leaving its files. A plain folder holds none until one is added.
import { useState, type ReactNode } from "react";
import { Button, Dialog, Input, Text } from "../../ui";
import type { ProjectRepo, ProjectSettings as Settings, ProjectSummary } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { repoName } from "../factory/model";
import { errorText, useHubCall, useLive } from "./hub";
import { Setting, useProjects } from "./parts";
import { addInput, applied, checkoutPath, isOwn, sourceProblem, type Applied } from "./repoModel";
import s from "./settings.module.css";

type Echo = { ok: boolean; text: string };

export function RepoSetting({ settings }: { settings: Settings }) {
  const projects = useProjects() ?? [];
  const repos = projects.find((p) => p.machineId === settings.machineId && p.projectId === settings.projectId)?.repos ?? [];
  const [echo, setEcho] = useState<Echo | null>(null);
  const [removing, setRemoving] = useState<ProjectRepo | null>(null);
  return (
    <Setting reveal="projects.repos" label="Repos" help="The git repos the project holds, and the setup and preview each one runs with.">
      {repos.length === 0 ? (
        <Text size="sm" tone="quiet">
          No repo, a plain folder.
        </Text>
      ) : (
        <div role="list" aria-label="Repos" className={s.repoList}>
          {repos.map((repo) => (
            <RepoRow key={repo.repoId} repo={repo} settings={settings} projects={projects} onRemove={isOwn(repo, settings) ? null : () => setRemoving(repo)} />
          ))}
        </div>
      )}
      <AddRepo settings={settings} onDone={setEcho} />
      {echo ? (
        <div role={echo.ok ? "status" : "alert"}>
          <Text size="sm" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </div>
      ) : null}
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
    </Setting>
  );
}

/** A path on the project's machine or a GitHub repo, and an optional name; a clone shows here once it lands. */
function AddRepo({ settings, onDone }: { settings: Settings; onDone: (echo: Echo) => void }) {
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
  return (
    <>
      <div className={s.inline}>
        <Input aria-label="Repo to add" placeholder={`A checkout on ${machine}, or a GitHub URL`} value={source} onChange={(e) => setSource(e.target.value)} />
        <Input aria-label="Repo name" placeholder="Name (optional)" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        <Button disabled={!live || busy || input === null} onClick={add}>
          {busy ? "Adding…" : "Add repo"}
        </Button>
      </div>
      {problem ? (
        <Text size="xs" tone="quiet">
          {problem}
        </Text>
      ) : null}
    </>
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

function RepoRow({
  repo,
  settings,
  projects,
  onRemove,
}: {
  repo: ProjectRepo;
  settings: Settings;
  projects: ReadonlyArray<ProjectSummary>;
  onRemove: (() => void) | null;
}) {
  const machine = useData((d) => d.machines[repo.checkout.machineId]?.name) ?? repo.checkout.machineId;
  // A hub before per-repo settings refuses `repo`: the project's then apply, as they do on it.
  const own = useToolQuery("project_settings_get", { machineId: settings.machineId, projectId: settings.projectId, repo: repo.name });
  const { setup, preview } = applied(settings, own.data?.settings);
  return (
    <div role="listitem" aria-label={repo.name} className={s.repoRow}>
      <div className={s.inline}>
        <Text strong>{repo.name}</Text>
        {onRemove ? (
          <Button size="sm" onClick={onRemove}>
            Remove…
          </Button>
        ) : null}
      </div>
      <dl className={s.repoFacts}>
        <Fact label="Remote">{repo.repoKey ? <Text size="sm" mono>{repoName(repo.repoKey)}</Text> : <Quiet>None</Quiet>}</Fact>
        <Fact label="Base branch">{repo.base ? <Text size="sm" mono>{repo.base}</Text> : <Quiet>Not known yet</Quiet>}</Fact>
        <Fact label="Checkout">
          <Text size="sm">
            <code>{checkoutPath(repo, projects)}</code> on {machine}
          </Text>
        </Fact>
        <Fact label="Setup">
          <AppliedLine applied={setup} />
        </Fact>
        <Fact label="Preview">
          <AppliedLine applied={preview} />
        </Fact>
      </dl>
    </div>
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

function AppliedLine({ applied: a }: { applied: Applied }) {
  if (a.own) return a.line ? <Text size="sm" mono>{a.line}</Text> : <Quiet>None</Quiet>;
  return (
    <Quiet>
      Uses the project's: {a.line ? <code>{a.line}</code> : "none"}
    </Quiet>
  );
}
