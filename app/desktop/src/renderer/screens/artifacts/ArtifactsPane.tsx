// A chat's Artifacts (W367, D292): the reports its lead or agents published with publish_artifact, the newest
// first, each one line, its title and when (who published it, its format and version in its hover); then the files
// sent in the chat, each opening in this computer's app for its type or saved, as its chat card does
// (main/files.ts). One artifact (`artifacts/<name>[/<version>]`, the
// wide panel) shows its newest version, or the one a card or link named, with a picker for every kept version:
// Markdown rendered in the app's own style (no raw HTML), HTML in a sandboxed frame of its own (HtmlFrame) with its
// scripts on and no network or reach into the app. Reads artifacts_list and artifact_get; artifacts.changed reads
// both again, so a new version shows while it is open.
import { Download, FileCode2, FileText } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type { ArtifactFormat, ChatFile, ProjectRef } from "../../../shared/contracts";
import { glyphOf } from "../../../shared/files";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Markdown, Select, Text, Tooltip, toast } from "../../ui";
import { GLYPHS } from "../chat/blocks/FileCard";
import { errorText } from "../settings/hub";
import { GroupLabel, PanelEmpty } from "../panel/folds";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { HtmlFrame } from "./HtmlFrame";
import { fileDetail, formatWord, metaLine, rowDetail, versionLabel } from "./model";
import { when } from "../live/when";
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
  const files = list.data?.files ?? [];
  if (rows.length === 0 && files.length === 0) {
    return (
      <div className={s.screen} data-screen="artifacts.empty">
        <PanelEmpty title="No artifacts yet" />
      </div>
    );
  }
  return (
    <div className={s.screen} data-screen="artifacts">
      <div className={s.rows}>
        {rows.length > 0 ? (
          <ul className={s.group} aria-label="Artifacts">
            {rows.map((a) => (
              <li key={a.name}>
                <Tooltip content={rowDetail(a.newest)} side="left">
                  <button type="button" className={s.row} data-artifact={a.name} onClick={() => open(project, a.name)}>
                    <FormatIcon format={a.newest.format} className={s.icon} />
                    <span className={s.title}>{a.newest.title}</span>
                    <span className={s.when}>{when(a.newest.at, now)}</span>
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : null}
        {files.length > 0 ? (
          <section aria-label="Files">
            <GroupLabel label="Files" count={files.length} />
            <ul className={s.group}>
              {files.map((f) => (
                <FileRow key={f.attachmentId} project={refOf(project)} file={f} now={now} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** A file sent in the chat: opens in this computer's app for its type, or saves. */
function FileRow({ project, file, now }: { project: ProjectRef; file: ChatFile; now: number }) {
  const { hub } = useDataLayer();
  const [busy, setBusy] = useState(false);
  const Glyph = GLYPHS[glyphOf(file.mime)];
  const act = async (what: "open" | "save") => {
    if (busy) return;
    setBusy(true);
    const request = { projectRef: project, attachmentId: file.attachmentId };
    const out = await (what === "open" ? window.fleetd.files.open(hub, request) : window.fleetd.files.save(hub, request)).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!out.ok) toast({ tone: "danger", title: what === "open" ? `Couldn’t open ${file.name}` : `Couldn’t save ${file.name}`, description: out.message });
  };
  return (
    <li className={s.fileItem}>
      <Tooltip content={fileDetail(file)} side="left">
        <button type="button" className={s.row} data-file={file.name} aria-busy={busy} onClick={() => void act("open")}>
          <Glyph aria-hidden className={s.icon} />
          <span className={s.title}>{file.name}</span>
          <span className={s.when}>{when(file.at, now)}</span>
        </button>
      </Tooltip>
      <Button variant="ghost" size="sm" iconOnly icon={<Download />} className={s.save} aria-label={`Save ${file.name}`} title="Save…" disabled={busy} onClick={() => void act("save")} />
    </li>
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
