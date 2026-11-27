// Memory, as the plain text files the hub keeps (D212): a project's MEMORY.md and the topic files it lists, on its
// Instructions & memory, which only its sessions get; your own memory, on You › Your memory, which only the agents of
// work you start read, and only you edit. The lead writes with `remember`; here a person reads
// each file as a list of entries (one card per line, with where and when the lead
// remembered it when the hub knows, and on a bot's, who taught it), edits or deletes one (its buttons, or its right-click
// menu), and undoes a delete from its toast. A bot's change that loosens what asks or merges, from someone who isn't an
// admin, waits on top until an admin keeps it or not. "Edit as text" is the whole file in a textarea. Every change is the file's new text through
// memory_set, a human key's write.
import { MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { MemoryFile, MemoryHeld, MemoryNote, MemorySetInput, ProjectRef } from "../../../shared/contracts";
import { Button, ContextMenu, ContextMenuItem, Field, Input, Text, Textarea, toast, Tooltip } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { projectRefOf, scopeKey, type Draft, type Scope } from "./editor";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import {
  authorWord,
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
import { RefreshedChanges } from "../chat/Remembered";
import { useBotLocked } from "./botAdmin";
import { DangerButton, GroupNote, scopeName, SettingsList, SettingsListRow, SettingsSection, useProjects } from "./parts";
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

/** Memory, on a project's Instructions & memory: the project's own files. Yours is on You › Your memory. */
export function Memory({ project }: { project: Scope | null }) {
  const live = useLive();
  const [query, setQuery] = useState("");
  const ref = project ? projectRefOf(project) : undefined;
  const read = useToolQuery("memory_get", ref ? { projectRef: ref } : {}, { enabled: live });
  const hubCall = useHubCall();
  const refetch = useRefetch();

  const save = (input: MemorySetInput) => hubCall("memory_set", input).then(() => refetch(["memory_get"]));
  // A file's text as the hub has it now, not as last shown: what an undo puts its entry back into.
  const reread = async (t: Target): Promise<string> => {
    const now = await hubCall("memory_get", t.projectRef ? { projectRef: t.projectRef } : {});
    const name = fileName(t);
    return now.files?.find((f) => fileName(f) === name)?.text ?? "";
  };

  const head = "What the lead remembers about this bot. Edit or delete anything that's wrong.";
  if (!live) {
    return (
      <SettingsSection title="Memory" reveal="memory" hint={head}>
        <GroupNote>Not connected. Connect to a workspace to see what its leads remember.</GroupNote>
      </SettingsSection>
    );
  }

  const d = read.data;
  const files = ref && d?.files ? d.files : [];
  const all = files;
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
    <>
      <SettingsSection title="Memory" reveal="memory" hint={head} bare>
        {read.isLoadingError ? <FileError read={read} /> : null}
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
        {total ? <CapMeter state={total} label="This bot's memory" /> : null}
      </SettingsSection>
      {ref && d?.held && d.held.length > 0 ? <HeldLines project={ref} held={d.held} /> : null}
      {ref && d?.files
        ? files.map((f) =>
            group(
              f,
              projectTarget(ref, f),
              f.topic ? f.topic : "Always on",
              f.topic ? "Read when needed." : "Always read.",
              { files, cap: d.projectCap ?? 0 },
            ),
          )
        : null}
    </>
  );
}

/**
 * You › Your memory: how you work, as the leads remember it. The agents of work you start read its core every turn and
 * open a topic when its work comes up; only you edit it (memory_set at user scope writes the caller's own). On top, the
 * last tidy's "Memory refreshed" line with its Undo; then the core; then each topic, a row that opens in place. On a
 * hub with no people it is the hub's one user.md.
 */
export function YourMemory() {
  const live = useLive();
  const read = useToolQuery("memory_get", {}, { enabled: live });
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const topics = read.data?.userFiles ?? [];
  const tidy = read.data?.tidied;
  const tidyRun = read.data?.tidyRun;
  const searching = query.trim() !== "";
  if (!live) {
    return (
      <SettingsSection>
        <GroupNote>Not connected. Connect to a workspace to see what its leads remember about you.</GroupNote>
      </SettingsSection>
    );
  }
  return (
    <>
      {read.isLoadingError ? (
        <SettingsSection bare>
          <FileError read={read} />
        </SettingsSection>
      ) : null}
      {tidyRun?.state === "failed" ? (
        <SettingsSection bare data={{ "data-memory-tidy-failed": "" }}>
          <GroupNote tone="danger">{`Your memory's last tidy didn't run: ${tidyRun.why ?? "it failed"}`}</GroupNote>
        </SettingsSection>
      ) : null}
      {tidy?.memoryRefreshed ? (
        <SettingsSection bare data={{ "data-memory-tidied": "" }}>
          <RefreshedChanges project={tidy.projectRef} message={tidy} refreshed={tidy.memoryRefreshed} at={when(tidy.createdAt)} />
        </SettingsSection>
      ) : null}
      <MemoryGroup
        bare
        label="Your memory"
        help=""
        name="your memory"
        file={read.data?.user}
        query={query}
        search={<Input type="search" aria-label="Search your memory" placeholder="Search entries" value={query} onChange={(e) => setQuery(e.target.value)} />}
        onSave={(text) => hubCall("memory_set", { scope: "user", text }).then(() => refetch(["memory_get"]))}
        reread={() => hubCall("memory_get", {}).then((now) => now.user.text)}
        deletable={false}
      />
      {topics.length > 0 ? (
        <SettingsSection title="Topics">
          <SettingsList label="Topics">
            {topics.map((f) => {
              const topic = f.topic as string;
              const open = opened.has(topic) || (searching && memoryLines(f).some((l) => l.kind === "entry" && lineMatches(l, query)));
              return (
                <SettingsListRow
                  key={topic}
                  name={topic}
                  label={topic}
                  expanded={open}
                  open={{ onClick: () => setOpened(toggled(opened, topic)) }}
                  data={{ "data-memory-topic": topic }}
                >
                  {open ? (
                    <MemoryGroup
                      bare
                      label={topic}
                      help=""
                      name={`${topic}.md`}
                      file={f}
                      query={query}
                      onSave={(text) => hubCall("memory_set", { scope: "user", topic, text }).then(() => refetch(["memory_get"]))}
                      reread={() => hubCall("memory_get", {}).then((now) => now.userFiles?.find((u) => u.topic === topic)?.text ?? "")}
                      deletable
                    />
                  ) : null}
                </SettingsListRow>
              );
            })}
          </SettingsList>
        </SettingsSection>
      ) : null}
    </>
  );
}

const toggled = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

function FileError({ read }: { read: { isLoadingError: boolean; error: unknown; refetch: () => unknown } }) {
  return (
    <div className={s.inline}>
      <Text tone="danger">{errorText(read.error)}</Text>
      <Button onClick={() => void read.refetch()}>Try again</Button>
    </div>
  );
}

const projectTarget = (projectRef: ProjectRef, f: MemoryFile): Target => ({ scope: "project", projectRef, ...(f.topic ? { topic: f.topic } : {}) });

/** A file's length against its cap, as a bar and in words; `compact`, a small bar at its section's line, the words on hover. */
function CapMeter({ state, label, changed, inGroup, compact }: { state: CapState; label: string; changed?: string | undefined; inGroup?: boolean; compact?: boolean }) {
  const fill = state.cap > 0 ? Math.min(100, (state.chars / state.cap) * 100) : 0;
  if (compact === true) {
    // At the head of its file's group: a short bar, then its words; when it changed is the hover.
    return (
      <span className={m.meterCompact} data-cap-meter="" title={changed ? `Changed ${when(changed)}` : undefined}>
        <span className={m.track} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={state.cap} aria-valuenow={state.chars} aria-valuetext={state.line}>
          <span className={m.fill} data-over={state.over || undefined} style={{ width: `${String(Math.max(fill, 2))}%` }} />
        </span>
        <Text size="xs" tone={state.over ? "danger" : "quiet"}>
          {state.line}
        </Text>
      </span>
    );
  }
  return (
    <div className={inGroup === true ? `${m.meter} ${m.inGroup}` : m.meter}>
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
  /** The page's one file, which the page already names: no label of its own, only Edit as text. */
  bare?: boolean;
  /** Where a search for the file lands. */
  part?: string;
  /** The page's search, beside Edit as text, when this file is all the page searches. */
  search?: ReactNode;
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
  // A person's own memory is never refused for size (a tidy trims it), so its cap never blocks a save.
  const capOf = (next: string): CapState[] => file?.scope === "user" ? [] : [
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
    <SettingsSection
      title={props.bare === true ? undefined : props.label}
      part={props.part}
      intro={file && !asText ? <CapMeter state={capState(text, file.cap)} label={`${name} against its cap`} changed={file.updatedAt} compact /> : undefined}
      hint={
        props.bare === true ? undefined : (
          <>
            <span data-text="code">{name}</span>
            {` · ${props.help}`}
          </>
        )
      }
      aside={
        <div className={m.tools}>
          {props.search}
          <Button variant="ghost" size="sm" disabled={file === undefined} onClick={() => setAsText(!asText)}>
            {asText ? "Show entries" : "Edit as text"}
          </Button>
        </div>
      }
      bare={asText}
    >
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
          {file === undefined ? (
            <GroupNote>Loading…</GroupNote>
          ) : lines.length === 0 ? (
            <GroupNote>Nothing remembered yet.</GroupNote>
          ) : shown.length === 0 ? (
            <GroupNote>No entry here matches.</GroupNote>
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
    </SettingsSection>
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
          <ContextMenu
            disabled={busy !== null}
            menu={() => (
              <>
                <ContextMenuItem icon={<Pencil />} onSelect={() => setDraft(line.text)}>
                  Edit
                </ContextMenuItem>
                <ContextMenuItem icon={<Trash2 />} danger onSelect={() => run("deleting", props.onDelete)}>
                  Delete
                </ContextMenuItem>
              </>
            )}
          >
            <div className={m.cardBody}>
              <div className={m.entryText}>
                <Text>{line.text}</Text>
                {line.by !== undefined ? (
                  <Text size="xs" tone="quiet" className={m.author}>
                    From {line.by}
                  </Text>
                ) : null}
              </div>
              <div className={m.cardActions}>
                {line.note ? <Source note={line.note} /> : null}
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
          </ContextMenu>
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

/**
 * A bot's changes that wait for an admin's OK, as they loosen what asks or merges: each with who taught it, and for an
 * owner or admin Keep (written to memory then) and Don't keep. A member sees them waiting, with no buttons.
 */
function HeldLines({ project, held }: { project: ProjectRef; held: ReadonlyArray<MemoryHeld> }) {
  const locked = useBotLocked();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (h: MemoryHeld, keep: boolean) => {
    setBusy(h.messageId);
    setError(null);
    hubCall("memory_hold_answer", { projectRef: project, messageId: h.messageId, keep })
      .then(() => refetch(["memory_get"]))
      .then(
        () => setBusy(null),
        (e: unknown) => {
          setBusy(null);
          setError(errorText(e));
        },
      );
  };
  const hint = locked
    ? "These loosen what asks or merges, so they wait for an owner or admin. Until then the bot goes by its memory as it is."
    : "These loosen what asks or merges. Nothing changes until you keep one.";
  return (
    <SettingsSection title="Waiting for an admin" hint={hint} data={{ "data-memory-held": "" }}>
      <ul className={m.entries} aria-label="Waiting for an admin">
        {held.map((h) => (
          <li key={h.messageId} className={m.card}>
            <div className={m.cardBody}>
              <div className={m.entryText}>
                <Text>{h.text}</Text>
                <Text size="xs" tone="quiet" className={m.author}>
                  {[`From ${authorWord(h)}`, h.forgotten === true ? "would take this out" : h.replaced !== undefined ? `in place of “${h.replaced}”` : undefined, h.topic]
                    .filter((w) => w !== undefined)
                    .join(" · ")}
                </Text>
              </div>
              {locked ? null : (
                <div className={m.heldActions}>
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => answer(h, true)}>
                    Keep
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => answer(h, false)}>
                    Don't keep
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div role="status">
        {error ? (
          <Text size="xs" tone="danger">
            {error}
          </Text>
        ) : null}
      </div>
    </SettingsSection>
  );
}

/** Where an entry came from: the lead's "Remembered: …" line in a project's chat, and when. */
function Source({ note }: { note: MemoryNote }) {
  const projects = useProjects();
  const words = `Remembered by the lead · ${when(note.at)} in ${scopeName({ kind: "project", ref: note.projectRef }, projects)}`;
  return (
    <Tooltip content={words}>
      <a className={m.source} href={noteHref(note)} aria-label={words}>
        <MessageSquareText aria-hidden />
      </a>
    </Tooltip>
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
  const over = file?.scope !== "user" && (cap.over || (total?.over ?? false));
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
      {/* Save shows once there is a change to save. */}
      {dirty || busy || props.onDelete ? (
        <div className={s.actions}>
          {dirty || busy ? (
            <>
              <Button variant="primary" disabled={file === undefined || !dirty || over || busy} onClick={() => run(() => props.onSave(draft.text), "Saved. New sessions get it.")}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" disabled={!dirty} onClick={() => setDraft({ ...draft, text: draft.from })}>
                Discard changes
              </Button>
            </>
          ) : null}
          {props.onDelete ? (
            <DangerButton disabled={busy || file === undefined} onClick={() => run(props.onDelete ?? (() => Promise.resolve()), "Deleted.")}>
              Delete {name}
            </DangerButton>
          ) : null}
        </div>
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
