// Settings → Memory: what the leads remember, as the plain text files the hub keeps. user.md goes to every project's
// lead and writers; a project's MEMORY.md (and the topic files it lists) only to that project's. The lead writes with
// `remember`; here a person reads, edits and deletes (memory_set, a human key's write).
import { useEffect, useState } from "react";
import type { MemoryFile, MemorySetInput, ProjectRef } from "../../../shared/contracts";
import { Button, Field, Separator, Text, Textarea } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { parseScope, projectRefOf, scopeKey, type Draft, type Scope } from "./editor";
import { MemoryCaps } from "./MemoryCaps";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { capState, fileName, noteHref, projectCapState } from "./memoryModel";
import { PageHead, ScopeSelect, scopeName, useProjects } from "./parts";
import { replaceRoute, type SettingsRoute } from "./route";
import s from "./settings.module.css";

const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function Memory({ route }: { route: SettingsRoute }) {
  const live = useLive();
  const projects = useProjects();
  const [project, setProject] = useState<Scope | null>(() => (route.for ? parseScope(route.for) : null));
  const ref = project ? projectRefOf(project) : undefined;
  const read = useToolQuery("memory_get", ref ? { projectRef: ref } : {}, { enabled: live });
  const hubCall = useHubCall();
  const refetch = useRefetch();

  useEffect(() => {
    replaceRoute({ tab: "memory", for: project?.kind === "project" ? scopeKey(project) : null });
  }, [project]);

  const save = (input: MemorySetInput) => hubCall("memory_set", input).then(() => refetch(["memory_get"]));

  if (!live) {
    return (
      <div className={s.scroll} data-screen="settings.memory">
        <div className={s.column}>
          <PageHead title="Memory" />
          <Text tone="quiet">Not connected. Connect to a hub to see what its leads remember.</Text>
        </div>
      </div>
    );
  }

  const d = read.data;
  const files = d?.files ?? [];
  const name = project ? scopeName(project, projects) : null;
  return (
    <div className={s.scroll} data-screen="settings.memory">
      <div className={s.column}>
        <PageHead title="Memory">
          What the leads remember when you correct them or set a rule. Each session starts with it; edit or delete anything that is wrong.
        </PageHead>
        {read.isLoadingError ? (
          <div className={s.inline}>
            <Text tone="danger">{errorText(read.error)}</Text>
            <Button onClick={() => void read.refetch()}>Try again</Button>
          </div>
        ) : null}
        <FileEditor
          label="You"
          help="How you work, for every project's lead and writers."
          file={d?.user}
          onSave={(text) => save({ scope: "user", text })}
        />
        <Separator />
        <div className={s.stack}>
          <div className={s.setting}>
            <div className={s.settingLabel}>
              <Text strong>One project</Text>
              <Text size="xs" tone="quiet">
                {name ? `Only ${name}'s sessions get this.` : "Pick a project to see what its lead remembers."}
              </Text>
            </div>
            <ScopeSelect id="memory-for" className={s.scopeSelect} value={project} projects={projects} onChange={setProject} />
          </div>
          {ref && d?.files
            ? files.map((f) => (
                <FileEditor
                  key={`${scopeKey({ kind: "project", ref })}/${fileName(f)}`}
                  label={fileName(f)}
                  help={f.topic ? "Opened by the lead when it needs it." : "Every session of this project starts with it."}
                  file={f}
                  project={{ files, cap: d.projectCap ?? 0 }}
                  onSave={(text) => save(projectInput(ref, f, text))}
                  {...(f.topic ? { onDelete: () => save(projectInput(ref, f, "")) } : {})}
                />
              ))
            : null}
        </div>
        <Separator />
        <MemoryCaps caps={d?.caps} />
      </div>
    </div>
  );
}

const projectInput = (projectRef: ProjectRef, f: MemoryFile, text: string): MemorySetInput => ({
  scope: "project",
  projectRef,
  ...(f.topic ? { topic: f.topic } : {}),
  text,
});

/** One file: its text to edit, its length against its cap, and the entries the lead wrote, each linked to its chat line. */
function FileEditor(props: {
  label: string;
  help: string;
  /** Undefined while loading. */
  file: MemoryFile | undefined;
  project?: { files: ReadonlyArray<MemoryFile>; cap: number };
  onSave: (text: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const { file } = props;
  const projects = useProjects();
  const saved = file?.text ?? "";
  const [draft, setDraft] = useState<Draft>({ from: saved, text: saved });
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  // The hub's newer text replaces an untouched draft; an edit in progress stays.
  if (draft.from !== saved && draft.text === draft.from) setDraft({ from: saved, text: saved });
  const dirty = draft.text !== draft.from;
  const cap = capState(draft.text, file?.cap ?? 0);
  const total = props.project && file ? projectCapState(props.project.files, { name: fileName(file), text: draft.text }, props.project.cap) : null;
  const over = cap.over || (total?.over ?? false);

  const run = (work: () => Promise<void>, done: string) => {
    setBusy(true);
    setEcho(null);
    work().then(
      () => {
        setBusy(false);
        setEcho({ ok: true, text: done });
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  return (
    <div className={s.stack}>
      {/* The file exactly as kept, markdown included: a code view to the QA text rule. */}
      <div data-text="code">
        <Field label={props.label} description={props.help}>
          <Textarea
          value={draft.text}
          disabled={file === undefined}
          minRows={4}
          maxRows={20}
          placeholder={file === undefined ? "Loading…" : "Nothing remembered yet."}
          onChange={(e) => setDraft({ from: draft.from, text: e.target.value })}
          />
        </Field>
      </div>
      <Text size="xs" tone={over ? "danger" : "quiet"}>
        {total ? `${cap.line}; ${total.line}` : cap.line}
        {over ? ". Past the cap: merge or cut entries before saving." : ""}
      </Text>
      <div className={s.actions}>
        <Button variant="primary" disabled={file === undefined || !dirty || over || busy} onClick={() => run(() => props.onSave(draft.text), "Saved. New sessions get it.")}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft({ ...draft, text: draft.from })}>
          Discard changes
        </Button>
        {props.onDelete ? (
          <Button variant="danger" disabled={busy || file === undefined} onClick={() => run(props.onDelete ?? (() => Promise.resolve()), "Deleted.")}>
            Delete {props.label}
          </Button>
        ) : null}
      </div>
      {file && file.notes.length > 0 ? (
        <ul className={s.notes} aria-label={`What the lead remembered in ${props.label}`}>
          {file.notes.map((note) => (
            <li key={note.messageId}>
              <Text size="xs" tone="quiet">
                {note.text} ·{" "}
                <a href={noteHref(note)}>
                  {when(note.at)} in {scopeName({ kind: "project", ref: note.projectRef }, projects)}
                </a>
              </Text>
            </li>
          ))}
        </ul>
      ) : null}
      <div role="status">
        {echo ? (
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        ) : null}
      </div>
    </div>
  );
}
