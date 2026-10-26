// Settings → Memory: what the leads remember, as the plain text files the hub keeps. user.md goes to every project's
// lead and writers; a project's MEMORY.md (and the topic files it lists) only to that project's. The lead writes with
// `remember`; here a person reads each file as a list of entries (one card per line, with where and when the lead
// remembered it when the hub knows), edits or deletes one, and undoes a delete from its toast. "Edit as text" is the
// whole file in a textarea. Every change is the file's new text through memory_set, a human key's write.
import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MemoryFile, MemoryNote, MemorySetInput, ProjectRef } from "../../../shared/contracts";
import { Button, Field, Input, Separator, Text, Textarea, toast, Tooltip } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { parseScope, projectRefOf, scopeKey, type Draft, type Scope } from "./editor";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import {
  capState,
  fileName,
  lineMatches,
  memoryLines,
  noteHref,
  projectCapState,
  restoreLine,
  withLine,
  type CapState,
  type MemoryLine,
} from "./memoryModel";
import { PageHead, ScopeSelect, scopeName, useProjects } from "./parts";
import { replaceRoute, type SettingsRoute } from "./route";
import m from "./Memory.module.css";
import s from "./settings.module.css";

const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The files of one project, for its cap across them all. */
interface ProjectFiles {
  readonly files: ReadonlyArray<MemoryFile>;
  readonly cap: number;
}

/** Which file a write goes to: memory_set's input without the text. */
type Target = Omit<MemorySetInput, "text">;

export function Memory({ route }: { route: SettingsRoute }) {
  const live = useLive();
  const projects = useProjects();
  const [project, setProject] = useState<Scope | null>(() => (route.for ? parseScope(route.for) : null));
  const [query, setQuery] = useState("");
  const ref = project ? projectRefOf(project) : undefined;
  const read = useToolQuery("memory_get", ref ? { projectRef: ref } : {}, { enabled: live });
  const hubCall = useHubCall();
  const refetch = useRefetch();

  useEffect(() => {
    replaceRoute({ tab: "memory", for: project?.kind === "project" ? scopeKey(project) : null });
  }, [project]);

  const save = (input: MemorySetInput) => hubCall("memory_set", input).then(() => refetch(["memory_get"]));
  // A file's text as the hub has it now, not as last shown: what an undo puts its entry back into.
  const reread = async (t: Target): Promise<string> => {
    const now = await hubCall("memory_get", t.projectRef ? { projectRef: t.projectRef } : {});
    const name = fileName(t);
    return (t.scope === "user" ? now.user : now.files?.find((f) => fileName(f) === name))?.text ?? "";
  };

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
  const files = ref && d?.files ? d.files : [];
  const name = project ? scopeName(project, projects) : null;
  const all = d ? [d.user, ...files] : [];
  const hits = all.reduce((n, f) => n + memoryLines(f).filter((l) => l.kind === "entry" && lineMatches(l, query)).length, 0);
  const total = ref && d?.files ? projectCapState(files, null, d.projectCap ?? 0) : null;
  const group = (f: MemoryFile | undefined, target: Target, label: string, help: string, project?: ProjectFiles) => (
    <MemoryGroup
      key={`${target.projectRef ? scopeKey({ kind: "project", ref: target.projectRef }) : "user"}/${fileName(target)}`}
      label={label}
      help={help}
      name={fileName(target)}
      file={f}
      query={query}
      {...(project ? { project } : {})}
      onSave={(text) => save({ ...target, text })}
      reread={() => reread(target)}
      deletable={target.topic !== undefined}
    />
  );
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
        <div className={m.search}>
          <Input type="search" aria-label="Search memory" placeholder="Search entries" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div role="status">
            {query.trim() && d && hits === 0 ? (
              <Text size="sm" tone="quiet">
                No entry has “{query.trim()}”.
              </Text>
            ) : null}
          </div>
        </div>
        {group(d?.user, { scope: "user" }, "You", "How you work, for every project's lead and writers.")}
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
          {total ? <CapMeter state={total} label="This project's memory" /> : null}
          {ref && d?.files
            ? files.map((f) =>
                group(
                  f,
                  projectTarget(ref, f),
                  f.topic ? f.topic : "Always on",
                  f.topic ? "Opened by the lead when it needs it." : "Every session of this project starts with it.",
                  { files, cap: d.projectCap ?? 0 },
                ),
              )
            : null}
        </div>
      </div>
    </div>
  );
}

const projectTarget = (projectRef: ProjectRef, f: MemoryFile): Target => ({ scope: "project", projectRef, ...(f.topic ? { topic: f.topic } : {}) });

/** A file's length against its cap, as a bar and in words. */
function CapMeter({ state, label, changed }: { state: CapState; label: string; changed?: string | undefined }) {
  const fill = state.cap > 0 ? Math.min(100, (state.chars / state.cap) * 100) : 0;
  return (
    <div className={m.meter}>
      <div className={m.track} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={state.cap} aria-valuenow={state.chars} aria-valuetext={state.line}>
        <div className={m.fill} data-over={state.over || undefined} style={{ width: `${String(fill)}%` }} />
      </div>
      <Text size="xs" tone={state.over ? "danger" : "quiet"}>
        {state.line}
        {changed ? ` · changed ${when(changed)}` : ""}
      </Text>
    </div>
  );
}

let undoSeq = 0;

/** One file: its entries as cards under a search, or the whole text to edit. */
function MemoryGroup(props: {
  label: string;
  help: string;
  name: string;
  /** Undefined while loading. */
  file: MemoryFile | undefined;
  query: string;
  project?: ProjectFiles;
  onSave: (text: string) => Promise<void>;
  /** The file's text on the hub now. */
  reread: () => Promise<string>;
  /** A topic file, which Edit as text can delete whole. */
  deletable: boolean;
}) {
  const { file, name } = props;
  const [asText, setAsText] = useState(false);
  // Lines deleted from this text, hidden until the hub's newer text arrives.
  const [gone, setGone] = useState<{ text: string; raws: ReadonlyArray<string> }>({ text: "", raws: [] });
  const text = file?.text ?? "";
  const lines = (file ? memoryLines(file) : []).filter(
    (l) => !(gone.text === text && gone.raws.includes(l.raw)),
  );
  const searching = props.query.trim() !== "";
  const shown = searching ? lines.filter((l) => l.kind === "entry" && lineMatches(l, props.query)) : lines;

  // The project's cap is checked with this file's new text in place of its old.
  const capOf = (next: string): CapState[] => [
    capState(next, file?.cap ?? 0),
    ...(props.project ? [projectCapState(props.project.files, { name, text: next }, props.project.cap)] : []),
  ];

  // Writes to this file one at a time, each built from the hub's text read just before it, never from the text last
  // shown: two quick deletes, or an edit right after a save, then each apply to what the one before wrote, and a line
  // the lead added since the last read stays.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const write = (change: (now: string) => string): Promise<void> => {
    const run = queue.current.then(async () => {
      const now = await props.reread();
      const next = change(now);
      if (next !== now) await props.onSave(next);
    });
    queue.current = run.catch(() => undefined);
    return run;
  };

  const undo = (line: MemoryLine, key: string) =>
    write((now) => restoreLine(now, line)).then(
      () => {
        // Put back, the file can read exactly as it did before the delete: stop hiding the line, or it stays hidden.
        setGone((g) => ({ ...g, raws: g.raws.filter((r) => r !== line.raw) }));
        toast({ key, title: `Put back in ${name}`, tone: "success" });
      },
      (e: unknown) => toast({ key, title: "Couldn't put it back", description: errorText(e), tone: "danger" }),
    );
  const remove = async (line: MemoryLine) => {
    await write((now) => withLine(now, name, line, null));
    setGone((g) => ({ text, raws: [...(g.text === text ? g.raws : []), line.raw] }));
    const key = `memory-undo-${String(++undoSeq)}`;
    toast({ key, title: `Deleted from ${name}`, description: line.text, action: { label: "Undo", onClick: () => void undo(line, key) } });
  };

  return (
    <section className={m.group} aria-label={`${props.label} (${name})`}>
      <div className={m.groupHead}>
        <div className={s.settingLabel}>
          <div className={m.title}>
            <Text strong>{props.label}</Text>
            <span data-text="code">
              <Text size="xs" tone="quiet">
                {name}
              </Text>
            </span>
          </div>
          <Text size="xs" tone="quiet">
            {props.help}
          </Text>
        </div>
        <Button variant="ghost" size="sm" disabled={file === undefined} onClick={() => setAsText(!asText)}>
          {asText ? "Show entries" : "Edit as text"}
        </Button>
      </div>
      {asText ? (
        <FileEditor
          label={`All of ${name}`}
          file={file}
          {...(props.project ? { project: props.project } : {})}
          // The whole file as typed, in turn with the cards' writes.
          onSave={(whole) => write(() => whole)}
          {...(props.deletable ? { onDelete: () => write(() => "") } : {})}
        />
      ) : (
        <>
          {file ? <CapMeter state={capState(text, file.cap)} label={`${name} against its cap`} changed={file.updatedAt} /> : null}
          {file === undefined ? (
            <Text size="sm" tone="quiet">
              Loading…
            </Text>
          ) : lines.length === 0 ? (
            <Text size="sm" tone="quiet">
              Nothing remembered yet.
            </Text>
          ) : shown.length === 0 ? (
            <Text size="sm" tone="quiet">
              No entry here matches.
            </Text>
          ) : (
            <ul className={m.entries} aria-label={`Entries of ${name}`}>
              {shown.map((line) =>
                line.kind === "heading" ? (
                  <li key={`${String(line.at)}:${line.raw}`} className={m.heading}>
                    <Text size="xs" strong tone="quiet">
                      {line.text}
                    </Text>
                  </li>
                ) : (
                  <EntryCard key={`${String(line.at)}:${line.raw}`} line={line} name={name} capOf={(next) => capOf(withLine(text, name, line, next))} onSave={(next) => write((now) => withLine(now, name, line, next))} onDelete={() => remove(line)} />
                ),
              )}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** One remembered line: what it says, where it came from, and its edit and delete. */
function EntryCard(props: {
  line: MemoryLine;
  name: string;
  /** The caps with this entry reading `next`; throws when the entry is no longer in the file. */
  capOf: (next: string) => CapState[];
  onSave: (next: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { line } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (kind: "saving" | "deleting", work: () => Promise<void>, after?: () => void) => {
    setBusy(kind);
    setError(null);
    work().then(
      () => {
        setBusy(null);
        after?.();
      },
      (e: unknown) => {
        setBusy(null);
        setError(errorText(e));
      },
    );
  };

  let caps: CapState[] = [];
  let gone: string | null = null;
  if (draft !== null) {
    try {
      caps = props.capOf(draft);
    } catch (e) {
      gone = errorText(e);
    }
  }
  const over = caps.find((c) => c.over);
  const blank = draft !== null && draft.trim() === "";
  const unchanged = draft !== null && draft.trim() === line.text;
  const canSave = draft !== null && !blank && !unchanged && !over && !gone && busy === null;
  const save = () => {
    if (canSave) run("saving", () => props.onSave(draft), () => setDraft(null));
  };

  return (
    <li className={m.card} data-editing={draft !== null || undefined}>
      {draft === null ? (
        <>
          <div className={m.cardBody}>
            <Text className={m.entryText}>{line.text}</Text>
            <div className={m.cardActions}>
              <Tooltip content="Edit">
                <Button variant="quiet" size="sm" iconOnly aria-label={`Edit “${line.text}”`} disabled={busy !== null} onClick={() => setDraft(line.text)}>
                  <Pencil aria-hidden />
                </Button>
              </Tooltip>
              <Tooltip content="Delete">
                <Button variant="quiet" size="sm" iconOnly aria-label={`Delete “${line.text}”`} disabled={busy !== null} onClick={() => run("deleting", props.onDelete)}>
                  <Trash2 aria-hidden />
                </Button>
              </Tooltip>
            </div>
          </div>
          {line.note ? <Source note={line.note} /> : null}
        </>
      ) : (
        <div className={s.stack}>
          <Textarea
            aria-label={`Edit the entry in ${props.name}`}
            value={draft}
            minRows={1}
            maxRows={8}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(null);
                setError(null);
              }
            }}
          />
          {over ? (
            <Text size="xs" tone="danger">
              {over.line}. Past the cap: shorten this or cut another entry.
            </Text>
          ) : null}
          <div className={s.actions}>
            <Button variant="primary" size="sm" disabled={!canSave} onClick={save}>
              {busy === "saving" ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div role="status">
        {gone || error ? (
          <Text size="xs" tone="danger">
            {gone ?? error}
          </Text>
        ) : busy === "deleting" ? (
          <Text size="xs" tone="quiet">
            Deleting…
          </Text>
        ) : null}
      </div>
    </li>
  );
}

/** Where an entry came from: the lead's "Remembered: …" line in a project's chat, and when. */
function Source({ note }: { note: MemoryNote }) {
  const projects = useProjects();
  return (
    <Text size="xs" tone="quiet">
      Remembered by the lead ·{" "}
      <a href={noteHref(note)}>
        {when(note.at)} in {scopeName({ kind: "project", ref: note.projectRef }, projects)}
      </a>
    </Text>
  );
}

/** One file as text: the whole of it to edit, its length against its cap, and Save; a cap refusal shows here. */
function FileEditor(props: {
  label: string;
  /** Undefined while loading. */
  file: MemoryFile | undefined;
  project?: ProjectFiles;
  onSave: (text: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const { file } = props;
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
  const name = file ? fileName(file) : "";

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
        <Field label={props.label}>
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
            Delete {name}
          </Button>
        ) : null}
      </div>
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
