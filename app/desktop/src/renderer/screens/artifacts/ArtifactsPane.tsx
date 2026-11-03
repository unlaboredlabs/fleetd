// A chat's Artifacts (W367, D292): the reports its lead, agents or Navi published with publish_artifact, the newest
// first, each its title over who published it, when and its version. One artifact (`artifacts/<name>[/<version>]`, the
// wide panel) shows its newest version, or the one a card or link named, with a picker for every kept version:
// Markdown rendered in the app's own style (no raw HTML), HTML in a sandboxed frame of its own (HtmlFrame) with its
// scripts on and no network or reach into the app. Reads artifacts_list and artifact_get; artifacts.changed reads
// both again, so a new version shows while it is open.
import { FileCode2, FileText } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type { ArtifactFormat, ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, EmptyState, Markdown, Select, Text } from "../../ui";
import { errorText } from "../settings/hub";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { HtmlFrame } from "./HtmlFrame";
import { formatWord, metaLine, versionLabel } from "./model";
import s from "./artifacts.module.css";

const refOf = (p: ProjectKey): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

const open = (project: ProjectKey, artifact: string | null, version?: number) =>
  navigate(panelRoute(project, { tab: "artifacts", artifact, ...(version === undefined ? {} : { version }) }));

export function FormatIcon({ format, className }: { format: ArtifactFormat; className?: string | undefined }) {
  const Icon = format === "html" ? FileCode2 : FileText;
  return <Icon aria-hidden className={className} />;
}

/** One artifact asks for the frame's wide width, so a report reads at a comfortable measure. */
export function ArtifactsTabView(props: { project: ProjectKey; artifact: string | null; version: number | undefined; onWide: (wide: boolean) => void }) {
  const { project, artifact, version, onWide } = props;
  useLayoutEffect(() => {
    onWide(artifact !== null);
  }, [artifact, onWide]);
  useLayoutEffect(() => () => onWide(false), [onWide]);
  return artifact === null ? <ArtifactsPane project={project} /> : <ArtifactView key={artifact} project={project} name={artifact} version={version} />;
}

function Loading({ label }: { label: string }) {
  return (
    <div className={s.skeleton} aria-busy="true" aria-label={label}>
      <span />
      <span />
    </div>
  );
}

export function ArtifactsPane({ project }: { project: ProjectKey }) {
  const fresh = useData((st) => st.fresh);
  const list = useToolQuery("artifacts_list", { projectRef: refOf(project) });
  // Day-grained stamps: read once a mount.
  const [now] = useState(() => Date.now());
  const rows = list.data?.artifacts;
  if (rows === undefined) {
    return (
      <div className={s.screen} data-screen={list.isError ? "artifacts.error" : "artifacts.loading"}>
        {!fresh ? (
          <div className={s.note}>
            <Text tone="quiet">Artifacts show once you’re connected.</Text>
          </div>
        ) : list.isError ? (
          <div className={s.note} role="alert">
            <Text tone="quiet">Couldn’t read the artifacts.</Text>
            <Button onClick={() => void list.refetch()}>Retry</Button>
          </div>
        ) : (
          <Loading label="Loading the artifacts" />
        )}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className={s.screen} data-screen="artifacts.empty">
        <div className={s.empty}>
          <EmptyState title="No artifacts yet">
            When the lead or an agent writes a report too long for the chat, it publishes it here, as a page or a document, and the chat shows a card for it. Every
            version is kept.
          </EmptyState>
        </div>
      </div>
    );
  }
  return (
    <div className={s.screen} data-screen="artifacts">
      <ul className={s.rows} aria-label="Artifacts">
        {rows.map((a) => (
          <li key={a.name}>
            <button type="button" className={s.row} data-artifact={a.name} onClick={() => open(project, a.name)}>
              <FormatIcon format={a.newest.format} className={s.icon} />
              <span className={s.words}>
                <span className={s.title}>{a.newest.title}</span>
                <Text size="xs" tone="quiet" className={s.meta}>
                  {`${formatWord(a.newest.format)} · ${metaLine(a.newest, now)}`}
                </Text>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArtifactView({ project, name, version }: { project: ProjectKey; name: string; version: number | undefined }) {
  const read = useToolQuery("artifact_get", { projectRef: refOf(project), name, ...(version === undefined ? {} : { version }) });
  const [now] = useState(() => Date.now());
  const got = read.data;
  if (got === undefined) {
    return (
      <div className={s.screen} data-screen={read.isError ? "artifact.error" : "artifact.loading"}>
        {read.isError ? (
          <div className={s.note} role="alert">
            <Text tone="quiet">{errorText(read.error)}</Text>
            <Button onClick={() => void read.refetch()}>Retry</Button>
          </div>
        ) : (
          <Loading label="Loading the artifact" />
        )}
      </div>
    );
  }
  const { artifact, versions } = got;
  const newest = versions[0]?.version ?? artifact.version;
  return (
    <div className={s.screen} data-screen={artifact.format === "html" ? "artifact.html" : "artifact"}>
      <header className={s.head}>
        <Text as="h2" size="lg" className={s.heading}>
          {artifact.title}
        </Text>
        <div className={s.toolbar}>
          {versions.length > 1 ? (
            <Select
              aria-label="Version"
              className={s.versions}
              value={String(artifact.version)}
              options={versions.map((v) => ({ value: String(v.version), label: versionLabel(v, newest, now) }))}
              onValueChange={(v) => open(project, name, Number(v) === newest ? undefined : Number(v))}
            />
          ) : (
            <Text size="xs" tone="quiet">
              {`${formatWord(artifact.format)} · ${metaLine(artifact, now)}`}
            </Text>
          )}
          {artifact.version !== newest ? (
            <Button size="sm" variant="quiet" onClick={() => open(project, name)}>
              Show the newest
            </Button>
          ) : null}
        </div>
      </header>
      {artifact.format === "html" ? (
        <HtmlFrame html={got.content} title={artifact.title} />
      ) : (
        <div className={s.scroll}>
          <div className={s.doc}>
            <Markdown source={got.content} blocks={false} />
          </div>
        </div>
      )}
    </div>
  );
}
