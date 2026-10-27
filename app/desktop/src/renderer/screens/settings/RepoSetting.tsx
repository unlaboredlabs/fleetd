// Settings → Projects → Repos: the git repos a project holds (ProjectSummary.repos), each with its remote, base
// branch, checkout, and the setup and preview it runs with, read with project_settings_get and `repo`. Read-only: a
// plain folder holds none, and adding or removing repos comes later.
import type { ReactNode } from "react";
import { Text } from "../../ui";
import type { ProjectRepo, ProjectSettings as Settings, ProjectSummary } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { repoName } from "../factory/model";
import { Setting, useProjects } from "./parts";
import { applied, checkoutPath, type Applied } from "./repoModel";
import s from "./settings.module.css";

export function RepoSetting({ settings }: { settings: Settings }) {
  const projects = useProjects() ?? [];
  const repos = projects.find((p) => p.machineId === settings.machineId && p.projectId === settings.projectId)?.repos ?? [];
  return (
    <Setting reveal="projects.repos" label="Repos" help="The git repos the project holds, and the setup and preview each one runs with.">
      {repos.length === 0 ? (
        <Text size="sm" tone="quiet">
          No repo, a plain folder.
        </Text>
      ) : (
        <div role="list" aria-label="Repos" className={s.repoList}>
          {repos.map((repo) => (
            <RepoRow key={repo.repoId} repo={repo} settings={settings} projects={projects} />
          ))}
        </div>
      )}
    </Setting>
  );
}

function RepoRow({ repo, settings, projects }: { repo: ProjectRepo; settings: Settings; projects: ReadonlyArray<ProjectSummary> }) {
  const machine = useData((d) => d.machines[repo.checkout.machineId]?.name) ?? repo.checkout.machineId;
  // A hub before per-repo settings refuses `repo`: the project's then apply, as they do on it.
  const own = useToolQuery("project_settings_get", { machineId: settings.machineId, projectId: settings.projectId, repo: repo.name });
  const { setup, preview } = applied(settings, own.data?.settings);
  return (
    <div role="listitem" aria-label={repo.name} className={s.repoRow}>
      <Text strong>{repo.name}</Text>
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
