// Settings → Skills: the SKILL.md workflows fleetd's agents get, global or for one project (which adds the project's
// own and its repo's .agents/skills and .claude/skills). A person views every one, edits, creates and deletes the
// ones the hub keeps (skill_set, skill_delete, a human key's writes), installs from a skills.sh source pinned to a
// commit (skill_install) and updates it (skill_update). Repo skills change in the repo.
import { useEffect, useState } from "react";
import type { ProjectRef, SkillScope, SkillSummary } from "../../../shared/contracts";
import { Button, Dialog, Field, IdChip, Input, Text, Textarea, cx } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { HUB, parseScope, projectRefOf, scopeKey, type Draft, type Scope } from "./editor";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { PageHead, ScopeSelect, scopeName, useProjects } from "./parts";
import { replaceRoute, type SettingsRoute } from "./route";
import { ORIGIN_LABEL, groups, installLine, nameProblem, rowKey, shadowLine, slug, template } from "./skillsModel";
import s from "./settings.module.css";
import k from "./skills.module.css";

type Echo = { ok: boolean; text: string } | null;

/** Where a write lands for the scope on screen: the project's skills, or the global ones. */
const target = (scope: Scope): { scope: SkillScope; projectRef?: ProjectRef } => {
  const ref = projectRefOf(scope);
  return ref ? { scope: "project", projectRef: ref } : { scope: "global" };
};

export function Skills({ route }: { route: SettingsRoute }) {
  const live = useLive();
  const projects = useProjects();
  const [scope, setScope] = useState<Scope>(() => (route.for ? parseScope(route.for) : HUB));
  const ref = projectRefOf(scope);
  const list = useToolQuery("skills_list", ref ? { projectRef: ref } : {}, { enabled: live });
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | "install" | null>(null);

  useEffect(() => {
    replaceRoute({ tab: "skills", for: scope.kind === "project" ? scopeKey(scope) : null });
  }, [scope]);
  const pickScope = (next: Scope) => {
    setScope(next);
    setSelected(null);
  };

  if (!live) {
    return (
      <div className={s.scroll} data-screen="settings.skills">
        <div className={s.column}>
          <PageHead title="Skills" />
          <Text tone="quiet">Not connected. Connect to a hub to see its skills.</Text>
        </div>
      </div>
    );
  }

  const skills = list.data?.skills ?? [];
  const current = skills.find((x) => rowKey(x) === selected);
  const where = scope.kind === "project" ? scopeName(scope, projects) : "every project";
  const writable = skills.filter((x) => x.origin === target(scope).scope).map((x) => x.name);
  return (
    <div className={s.scroll} data-screen="settings.skills">
      <div className={s.column}>
        <PageHead title="Skills">
          Workflows every agent can follow, from the repo, a project or the whole hub. Agents see each one&apos;s name and
          description, and open it when it fits. Name one in the chat with $.
        </PageHead>
        <div className={s.setting}>
          <div className={s.settingLabel}>
            <Text strong>Scope</Text>
            <Text size="xs" tone="quiet">
              {scope.kind === "project"
                ? `What ${where}'s agents get: its repo's, its own and the global skills. On a name clash the first wins.`
                : "Skills for every project's agents."}
            </Text>
          </div>
          <ScopeSelect id="skills-for" className={s.scopeSelect} value={scope} hubWide="Global" projects={projects} onChange={pickScope} />
        </div>
        <div className={s.actions}>
          <Button variant="primary" onClick={() => setDialog("new")}>
            New skill
          </Button>
          <Button onClick={() => setDialog("install")}>Install from a source…</Button>
        </div>
        {list.isLoadingError ? (
          <div className={s.inline}>
            <Text tone="danger">{errorText(list.error)}</Text>
            <Button onClick={() => void list.refetch()}>Try again</Button>
          </div>
        ) : null}
        {list.data?.repoUnavailable ? (
          <Text size="xs" tone="quiet">
            {list.data.repoUnavailable}
          </Text>
        ) : null}
        {list.data && skills.length === 0 ? <Text tone="quiet">No skills yet. Write one with New skill, or install one from skills.sh.</Text> : null}
        {groups(skills).map((g) => (
          <section key={g.origin} className={k.group} aria-label={ORIGIN_LABEL[g.origin]}>
            <Text size="xs" tone="quiet" strong>
              {ORIGIN_LABEL[g.origin]}
            </Text>
            <ul className={k.rows}>
              {g.rows.map((row) => (
                <li key={rowKey(row)}>
                  <button
                    type="button"
                    className={cx(k.row, rowKey(row) === selected && k.current, row.shadowedBy && k.shadowed)}
                    aria-pressed={rowKey(row) === selected}
                    onClick={() => setSelected(rowKey(row) === selected ? null : rowKey(row))}
                  >
                    <Text strong>{row.name}</Text>
                    <Text size="xs" tone="quiet" className={k.description}>
                      {row.description || "No description."}
                    </Text>
                    {shadowLine(row) ?? installLine(row) ? (
                      <Text size="xs" tone={row.shadowedBy ? "warning" : "faint"}>
                        {shadowLine(row) ?? installLine(row)}
                      </Text>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {current ? <SkillEditor key={rowKey(current)} skill={current} scope={scope} onGone={() => setSelected(null)} /> : null}
      </div>
      <NewSkill open={dialog === "new"} scope={scope} where={where} taken={writable} onClose={() => setDialog(null)} onMade={(name) => setSelected(`${target(scope).scope}/${name}`)} />
      <InstallSkills open={dialog === "install"} scope={scope} where={where} onClose={() => setDialog(null)} />
    </div>
  );
}

/** Where a write of `skill` goes: the hub's two scopes; none for the repo's. */
function writeTarget(skill: SkillSummary, ref: ProjectRef | undefined): { scope: SkillScope; projectRef?: ProjectRef } | null {
  if (skill.origin === "global") return { scope: "global" };
  if (skill.origin === "project" && ref) return { scope: "project", projectRef: ref };
  return null;
}

/** One skill's SKILL.md: edited and saved for the hub's, read for the repo's. */
function SkillEditor({ skill, scope, onGone }: { skill: SkillSummary; scope: Scope; onGone: () => void }) {
  const ref = projectRefOf(scope);
  const read = useToolQuery("skill_get", { origin: skill.origin, name: skill.name, ...(ref ? { projectRef: ref } : {}) });
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const saved = read.data?.text ?? "";
  const [draft, setDraft] = useState<Draft>({ from: saved, text: saved });
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  const [confirm, setConfirm] = useState(false);
  if (draft.from !== saved && draft.text === draft.from) setDraft({ from: saved, text: saved });
  const dirty = draft.text !== draft.from;
  const at = writeTarget(skill, ref);
  const canEdit = at !== null;
  const files = skill.files ?? [];

  const run = (work: () => Promise<string>) => {
    setBusy(true);
    setEcho(null);
    work().then(
      (text) => {
        setBusy(false);
        setEcho({ ok: true, text });
        refetch(["skills_list", "skill_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  return (
    <section className={k.editor} aria-label={`Skill ${skill.name}`}>
      <div className={k.editorHead}>
        <Text strong>{skill.name}</Text>
        <Text size="xs" tone="quiet">
          {ORIGIN_LABEL[skill.origin]}
          {files.length > 0 ? ` · ${files.length} more file${files.length === 1 ? "" : "s"}: ${files.join(", ")}` : ""}
        </Text>
        {skill.install ? (
          <div className={k.pin}>
            <Text size="xs" tone="quiet">
              {installLine(skill)}
            </Text>
            <IdChip label="Commit" id={skill.install.commit} kind="commit" size="xs" tone="quiet" />
          </div>
        ) : null}
      </div>
      {/* SKILL.md exactly as kept, frontmatter included: a code view to the QA text rule. */}
      <div data-text="code">
        <Field label="SKILL.md" description={canEdit ? "Sessions get a saved change from their next start." : `Read from the repo (${skill.path ?? ""}): change it there.`}>
          <Textarea
            mono
            value={draft.text}
            readOnly={!canEdit}
            disabled={read.data === undefined}
            minRows={8}
            maxRows={28}
            placeholder={read.data === undefined ? "Loading…" : ""}
            onChange={(e) => setDraft({ from: draft.from, text: e.target.value })}
          />
        </Field>
      </div>
      {at ? (
        <div className={s.actions}>
          <Button
            variant="primary"
            disabled={!dirty || busy}
            onClick={() => run(() => hubCall("skill_set", { ...at, name: skill.name, text: draft.text }).then(() => "Saved. New sessions get it."))}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => setDraft({ ...draft, text: draft.from })}>
            Discard changes
          </Button>
          {skill.install ? (
            <Button
              disabled={busy || dirty}
              onClick={() =>
                run(() =>
                  hubCall("skill_update", { ...at, name: skill.name }).then((o) =>
                    o.updated ? "Updated to the newest commit." : "Already at the newest commit.",
                  ),
                )
              }
            >
              Update
            </Button>
          ) : null}
          <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
            Delete
          </Button>
        </div>
      ) : null}
      <div role="status">
        {echo ? (
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${skill.name}?`}
        description="Its folder goes from the hub. Sessions that start from now on don't get it."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                if (!at) return;
                void hubCall("skill_delete", { ...at, name: skill.name }).then(
                  () => {
                    refetch(["skills_list"]);
                    onGone();
                  },
                  (e: unknown) => setEcho({ ok: false, text: errorText(e) }),
                );
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}

function NewSkill(props: { open: boolean; scope: Scope; where: string; taken: ReadonlyArray<string>; onClose: () => void; onMade: (name: string) => void }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = slug(typed);
  const problem = nameProblem(name, props.taken);
  const close = () => {
    setTyped("");
    setError(null);
    props.onClose();
  };
  const make = () => {
    if (problem) return setError(problem);
    setBusy(true);
    hubCall("skill_set", { ...target(props.scope), name, text: template(name), create: true }).then(
      () => {
        setBusy(false);
        refetch(["skills_list"]);
        props.onMade(name);
        close();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && close()}
      title="New skill"
      description={`For ${props.where}. It starts from a template you then edit.`}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || typed.trim() === ""} onClick={make}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <Field label="Name" description={name && name !== typed ? `Saved as ${name}` : "Lowercase, with hyphens: release-notes"} error={error ?? undefined}>
        <Input
          autoFocus
          value={typed}
          placeholder="release-notes"
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && make()}
        />
      </Field>
    </Dialog>
  );
}

function InstallSkills(props: { open: boolean; scope: Scope; where: string; onClose: () => void }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [source, setSource] = useState("");
  const [only, setOnly] = useState("");
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  const close = () => {
    setSource("");
    setOnly("");
    setEcho(null);
    props.onClose();
  };
  const install = () => {
    setBusy(true);
    setEcho(null);
    const skill = slug(only);
    hubCall("skill_install", { ...target(props.scope), source: source.trim(), ...(skill ? { skill } : {}) }).then(
      (o) => {
        setBusy(false);
        refetch(["skills_list"]);
        setEcho({ ok: true, text: `Installed ${o.installed.map((x) => x.name).join(", ")}, pinned to the commit fetched. Sessions get it from their next start.` });
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && close()}
      title="Install skills"
      description={`Into ${props.where}, pinned to the commit fetched. Nothing updates on its own: Update fetches newer commits.`}
      footer={
        <>
          <Button onClick={close}>{echo?.ok ? "Done" : "Cancel"}</Button>
          <Button variant="primary" disabled={busy || source.trim() === ""} onClick={install}>
            {busy ? "Installing…" : "Install"}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <Field label="Source" description="owner/repo, owner/repo@skill, a GitHub URL (…/tree/<branch>/<folder> too) or a git URL.">
          <Input autoFocus value={source} placeholder="vercel-labs/agent-skills" onChange={(e) => setSource(e.target.value)} />
        </Field>
        <Field label="Only this skill" description="Leave empty for every skill the source has.">
          <Input value={only} placeholder="web-design-guidelines" onChange={(e) => setOnly(e.target.value)} />
        </Field>
        <div role="status">
          {echo ? (
            <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
              {echo.text}
            </Text>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
