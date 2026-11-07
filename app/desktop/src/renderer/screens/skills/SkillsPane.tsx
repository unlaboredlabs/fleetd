// One of a project's skills in its panel (W238, D261), from the chat's line for it or Settings › Agents › Skills, where
// the list is (no panel tab lists them). One skill (`skills/<name>`, the wide panel) shows who changed it last, its SKILL.md
// rendered, an editor whose save is a version of the person's, its history (every version with who, when and why,
// each a diff against the one before, and Restore, which adds a new version), and turning it off or deleting it.
// A lead saves its skills with no approval; this is where the person audits and changes them. Reads skills_list and
// skill_get; writes skill_set, skill_revert, skill_off and skill_delete. Every write's skills.changed reads both again.
import { useLayoutEffect, useState } from "react";
import type { ProjectRef, SkillSummary, SkillVersion } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Button, Dialog, EmptyState, Field, Input, Markdown, Segmented, Switch, Text, Textarea, cx } from "../../ui";
import { useHubRole } from "../admin/role";
import { DiffBlock } from "../settings/DiffBlock";
import { errorText, useHubCall, useRefetch } from "../settings/hub";
import { navigate } from "../shell/navigation";
import { projectSkills, type ProjectKey } from "../shell/routes";
import { body, isOwn, metaLine, versionLine } from "./skillsModel";
import s from "./skills.module.css";

const refOf = (p: ProjectKey): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

/** One skill asks for the frame's wide width, so its SKILL.md and diffs read at a comfortable measure. */
export function SkillsTabView({ project, skill, onWide }: { project: ProjectKey; skill: string; onWide: (wide: boolean) => void }) {
  useLayoutEffect(() => {
    onWide(true);
  }, [onWide]);
  useLayoutEffect(() => () => onWide(false), [onWide]);
  return <SkillView key={skill} project={project} name={skill} />;
}

const useMe = (): string | undefined => useHubRole().me?.name;

type Mode = "read" | "history";
type Echo = { ok: boolean; text: string } | null;

function SkillView({ project, name }: { project: ProjectKey; name: string }) {
  const ref = refOf(project);
  const list = useToolQuery("skills_list", { projectRef: ref });
  const listed = list.data?.skills.find((x) => x.name === name && x.shadowedBy === undefined);
  const origin = listed?.origin ?? "project";
  const read = useToolQuery("skill_get", { origin, projectRef: ref, name }, { enabled: listed !== undefined });
  const [mode, setMode] = useState<Mode>("read");
  const [editing, setEditing] = useState(false);
  const me = useMe();
  const [now] = useState(() => Date.now());

  if (list.data !== undefined && listed === undefined) {
    return (
      <div className={s.screen} data-screen="skill.gone">
        <div className={s.empty}>
          <EmptyState title={`No skill called ${name}`}>It was deleted, or it was never this project’s.</EmptyState>
        </div>
      </div>
    );
  }
  if (listed === undefined || read.data === undefined) {
    return (
      <div className={s.screen} data-screen={read.isError ? "skill.error" : "skill.loading"}>
        {read.isError ? (
          <div className={s.note} role="alert">
            <Text tone="quiet">{errorText(read.error)}</Text>
            <Button onClick={() => void read.refetch()}>Retry</Button>
          </div>
        ) : (
          <div className={s.skeleton} aria-busy="true" aria-label="Loading the skill">
            <span />
            <span />
          </div>
        )}
      </div>
    );
  }
  const versions = read.data.versions ?? [];
  const own = isOwn(listed);
  return (
    <div className={s.screen} data-screen={editing ? "skill.edit" : mode === "history" ? "skill.history" : "skill"}>
      <div className={s.scroll}>
        <header className={s.head}>
          <div className={s.title}>
            <Text as="h2" size="lg" className={s.titleName}>
              {name}
            </Text>
            {listed.off === true ? (
              <Text size="xs" tone="quiet">
                Off
              </Text>
            ) : null}
          </div>
          {listed.description ? (
            <Text as="p" size="sm" tone="quiet">
              {listed.description}
            </Text>
          ) : null}
          <Text size="xs" tone="faint">
            {metaLine(listed, now, me)}
          </Text>
        </header>
        {editing ? (
          <Editor project={project} skill={listed} text={read.data.text} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className={s.toolbar}>
              <Segmented
                label="Show"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "read", label: "Skill" },
                  { value: "history", label: "History", ...(versions.length > 0 ? { count: String(versions.length) } : {}) },
                ]}
              />
              <span className={s.spacer} />
              {listed.origin === "project" || listed.origin === "global" ? <OffSwitch project={project} skill={listed} /> : null}
              {own ? (
                <Button size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              ) : null}
              {own ? <DeleteSkill project={project} skill={listed} /> : null}
            </div>
            {!own ? (
              <Text as="p" size="xs" tone="quiet" className={s.aside}>
                {listed.origin === "global" ? "Every project gets this one; an owner or admin changes it in Settings › Hub." : "It is a file in this project’s folder: change it there."}
              </Text>
            ) : listed.install ? (
              <Text as="p" size="xs" tone="quiet" className={s.aside}>
                Installed from {listed.install.source}. An update from Settings replaces your edits.
              </Text>
            ) : null}
            {mode === "read" ? (
              <div className={s.doc}>
                <Markdown source={body(read.data.text)} />
              </div>
            ) : (
              <History project={project} skill={listed} versions={versions} me={me} now={now} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function useWrite() {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  const run = (work: () => Promise<string>, done?: () => void) => {
    setBusy(true);
    setEcho(null);
    work().then(
      (text) => {
        setBusy(false);
        setEcho({ ok: true, text });
        refetch(["skills_list", "skill_get"]);
        done?.();
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  return { hubCall, busy, echo, run };
}

function EchoLine({ echo }: { echo: Echo }) {
  return (
    <div role="status">
      {echo ? (
        <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
          {echo.text}
        </Text>
      ) : null}
    </div>
  );
}

/** The person's edit: the whole SKILL.md, and an optional line on why. Save keeps it as a version of theirs. */
function Editor({ project, skill, text, onDone }: { project: ProjectKey; skill: SkillSummary; text: string; onDone: () => void }) {
  const [draft, setDraft] = useState(text);
  const [why, setWhy] = useState("");
  const { hubCall, busy, echo, run } = useWrite();
  const dirty = draft !== text;
  const save = () =>
    run(
      () =>
        hubCall("skill_set", { scope: "project", projectRef: refOf(project), name: skill.name, text: draft, ...(why.trim() ? { why: why.trim() } : {}) }).then(
          (o) => `Saved as version ${String(o.skill.changed?.version ?? "")}.`.replace(" .", "."),
        ),
      onDone,
    );
  return (
    <section className={s.editor} aria-label={`Edit ${skill.name}`}>
      <div data-text="code">
        <Field label="SKILL.md" description="Its frontmatter names it and says when to use it; the steps follow. The lead’s next session gets your change.">
          <Textarea mono value={draft} minRows={12} maxRows={32} onChange={(e) => setDraft(e.target.value)} />
        </Field>
      </div>
      <Field label="What changed" description="Optional. Kept with the version, beside the lead’s own reasons.">
        <Input value={why} maxLength={300} placeholder="Use the new portal address" onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => e.key === "Enter" && dirty && !busy && save()} />
      </Field>
      <div className={s.actions}>
        <Button variant="primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
      <EchoLine echo={echo} />
    </section>
  );
}

function OffSwitch({ project, skill }: { project: ProjectKey; skill: SkillSummary }) {
  const { hubCall, busy, echo, run } = useWrite();
  const on = skill.off !== true;
  return (
    <span className={s.switch}>
      <Switch
        label="On"
        checked={on}
        disabled={busy}
        onCheckedChange={(next: boolean) =>
          run(() =>
            hubCall("skill_off", { projectRef: refOf(project), name: skill.name, off: !next }).then(() =>
              next ? "On: its next session gets it." : "Off: its next session doesn’t get it.",
            ),
          )
        }
      />
      {echo !== null && !echo.ok ? <EchoLine echo={echo} /> : null}
    </span>
  );
}

function DeleteSkill({ project, skill }: { project: ProjectKey; skill: SkillSummary }) {
  const [confirm, setConfirm] = useState(false);
  const { hubCall, busy, echo, run } = useWrite();
  return (
    <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
        Delete
      </Button>
      {echo !== null && !echo.ok ? <EchoLine echo={echo} /> : null}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${skill.name}?`}
        description="It goes with its history. The lead’s next session doesn’t get it, though it may save a new one if it works the task out again."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                run(
                  () => hubCall("skill_delete", { scope: "project", projectRef: refOf(project), name: skill.name }).then(() => "Deleted."),
                  () => navigate(projectSkills(project)),
                );
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}

/** Every version, newest first; the one picked opens to what it changed against the one before, with Restore. */
function History(props: { project: ProjectKey; skill: SkillSummary; versions: readonly SkillVersion[]; me: string | undefined; now: number }) {
  const { project, skill, versions } = props;
  const [picked, setPicked] = useState<number | null>(versions[0]?.version ?? null);
  if (versions.length === 0) {
    return (
      <Text as="p" size="sm" tone="quiet" className={s.aside}>
        No history yet: it was written before fleetd kept versions. Its next change starts one.
      </Text>
    );
  }
  const newest = versions[0]?.version;
  return (
    <ol className={s.versions} aria-label="History">
      {versions.map((v, i) => (
        <li key={v.version} className={cx(s.version, v.version === picked && s.picked)} data-version={v.version}>
          <button type="button" className={s.versionHead} aria-expanded={v.version === picked} onClick={() => setPicked(v.version === picked ? null : v.version)}>
            <span className={s.versionName}>Version {v.version}</span>
            <Text size="xs" tone="quiet">
              {versionLine(v, props.now, props.me)}
            </Text>
            {v.version === newest ? (
              <Text size="xs" tone="faint">
                current
              </Text>
            ) : null}
          </button>
          {v.why !== undefined ? (
            <Text as="p" size="sm" className={s.why}>
              {v.why}
            </Text>
          ) : null}
          {v.version === picked ? <Change project={project} skill={skill} version={v} before={versions[i + 1]} current={v.version === newest} /> : null}
        </li>
      ))}
    </ol>
  );
}

function Change(props: { project: ProjectKey; skill: SkillSummary; version: SkillVersion; before: SkillVersion | undefined; current: boolean }) {
  const { project, skill, version, before } = props;
  const ref = refOf(project);
  const base = { origin: skill.origin, projectRef: ref, name: skill.name };
  const after = useToolQuery("skill_get", { ...base, version: version.version });
  const prior = useToolQuery("skill_get", { ...base, version: before?.version ?? version.version }, { enabled: before !== undefined });
  const { hubCall, busy, echo, run } = useWrite();
  const ready = after.data !== undefined && (before === undefined || prior.data !== undefined);
  return (
    <div className={s.change}>
      {!ready ? (
        <Text size="xs" tone="quiet" aria-busy="true">
          Loading the change…
        </Text>
      ) : (
        <DiffBlock
          label={before === undefined ? `Version ${String(version.version)}, as first kept` : `Version ${String(before.version)} to ${String(version.version)}`}
          before={before === undefined ? "" : (prior.data?.text ?? "")}
          after={after.data.text}
        />
      )}
      {!props.current && isOwn(skill) ? (
        <div className={s.actions}>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(() =>
                hubCall("skill_revert", { scope: "project", projectRef: ref, name: skill.name, version: version.version }).then(
                  (o) => `Restored as version ${String(o.skill.changed?.version ?? "")}.`.replace(" .", "."),
                ),
              )
            }
          >
            {busy ? "Restoring…" : `Restore version ${String(version.version)}`}
          </Button>
          <Text size="xs" tone="quiet">
            Adds a new version with this text; nothing is lost.
          </Text>
        </div>
      ) : null}
      <EchoLine echo={echo} />
    </div>
  );
}
