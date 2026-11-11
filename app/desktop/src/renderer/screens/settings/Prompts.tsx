// Built-in prompts: every text fleetd itself sends a model. No tab of their own: a project's open from the foot of its
// Instructions, and the hub-wide ones every project gets, which only owners and admins change (D209, D211), from the
// foot of Hub › Every project › Instructions. One list, the edited prompts first and the rest behind their groups; a
// prompt opens in a plain editor: its text, Save, Reset to the built-in. An edit whose built-in text changed since it
// was made shows both changes there, to save together. Warnings come from the hub's dry run as you type and never
// block a save. A running session keeps the text it started with.
import { Fragment, useEffect, useRef, useState } from "react";
import { Button, cx, Dialog, Dot, Text, Textarea, Tooltip } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { describe, listed, type CatalogRow } from "./catalog";
import { type PromptDetail, type PromptSummary, type PromptWarning, type RetiredPromptOverride } from "./contracts";
import { DiffBlock } from "./DiffBlock";
import {
  canSave,
  editScope,
  effectLine,
  hasConflictMarkers,
  hasOverride,
  insertAt,
  isDirty,
  parseScope,
  projectRefOf,
  resetLine,
  savedLine,
  scopeKey,
  startOn,
  synced,
  token,
  updateTarget,
  warningLine,
  type Filled,
  type Scope,
} from "./editor";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { ConfirmDiscard, GroupNote, NoProject, PageHead, scopeName, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects } from "./parts";
import { orphanAdvice, orphanTitle, targetName, whyLine } from "./orphans";
import { hashFor, navigate } from "../shell/navigation";
import { formatRoute, replaceHash, replaceRoute, type SettingsRoute } from "./route";
import s from "./settings.module.css";

type Switch = { scope: Scope; id: string | null };
type Echo = { ok: boolean; text: string };
type Checked = { text: string; warnings: ReadonlyArray<PromptWarning> };

/** A project's own prompts, or the hub-wide ones. */
export type PromptsWhere = "project" | "hub";

type Kept = { filled: Filled; text: string };

/** Each place's unsaved draft, kept while the page is closed or another one is open, so leaving does not lose it. */
const kept: Record<PromptsWhere, Kept | null> = { project: null, hub: null };

/** Where the page is, in the address bar: a project's built-in prompts, or the hub-wide ones. */
function placeRoute(where: PromptsWhere, prompt: string | null, project: string | null) {
  if (where === "project") replaceRoute({ tab: "prompts", prompt, for: project });
  else replaceHash(hashFor({ id: "settings", tab: "hub.prompts", ...(prompt === null ? {} : { prompt }) }));
}

export function Prompts({ route, where = "project" }: { route: SettingsRoute; where?: PromptsWhere }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const refetchPrompts = () => refetch(["prompt_get"]);
  const projects = useProjects();

  // A kept draft for another prompt or scope opens first, and the route waits behind the discard confirm.
  const [start] = useState(() => startOn(kept[where], route));
  const [scope, setScope] = useState<Scope>(start.scope);
  const [selected, setSelected] = useState<string | null>(start.id);
  const [pending, setPending] = useState<Switch | null>(start.ask);
  const sk = scopeKey(scope);
  const projectRef = projectRefOf(scope);

  const scoped = projectRef ? { projectRef } : {};
  const list = useToolQuery("prompt_get", scoped, { enabled: live });
  const detail = useToolQuery("prompt_get", { id: selected ?? "", ...scoped }, { enabled: live && selected !== null });

  const [editor, setEditor] = useState(() => kept[where]?.text ?? "");
  const [filled, setFilled] = useState<Filled | null>(() => kept[where]?.filled ?? null);
  const [seen, setSeen] = useState<PromptDetail | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  /** The groups unfolded in the list; they stay so while a prompt is open. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());

  // Fill the editor from what the hub sent for the prompt and scope on screen (see `synced`), during render so the
  // first paint of a new prompt already shows its text.
  // A project's page never offers a hub-wide change: an out-of-date hub-wide edit is the hub's page's to bring up to date.
  const raw = detail.data?.prompt ?? null;
  const d = !raw || where === "hub" || !raw.stale || raw.stale.scope === "project" ? raw : withoutStale(raw, seen);
  if (d && d !== seen) {
    setSeen(d);
    const next = synced(filled, d, sk, editor);
    if (next.refill) {
      setEditor(next.filled.text);
      // The hub's warnings are the text in effect's; both changes together get the dry run's.
      setChecked(d.stale ? null : { text: next.filled.text, warnings: d.warnings });
    }
    setFilled(next.filled);
  }
  const onScreen = d !== null && filled?.id === d.id && filled.scope === sk;
  // Known without the hub's answer, so a switch asked for before the prompt loads still asks first.
  const dirty = filled !== null && filled.id === selected && filled.scope === sk && isDirty(filled, editor);

  useEffect(() => {
    kept[where] = filled ? { filled, text: editor } : null;
  }, [where, filled, editor]);

  const forKey = scope.kind === "project" ? sk : null;
  useEffect(() => {
    placeRoute(where, selected, forKey);
  }, [where, selected, forKey]);

  // The dry run, after a pause in typing: what saving this text would warn about.
  useEffect(() => {
    if (!d || !onScreen || editor.trim() === "" || checked?.text === editor) return;
    const scopeOut = editScope(d, scope);
    const timer = window.setTimeout(() => {
      hubCall("prompt_set", {
        id: d.id,
        scope: scopeOut,
        ...(scopeOut === "project" && projectRef ? { projectRef } : {}),
        text: editor,
        dryRun: true,
      }).then(
        (o) => setChecked({ text: editor, warnings: o.warnings }),
        // A hub without the dry run: the save still answers with the warnings.
        () => undefined,
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [d, onScreen, editor, checked?.text, scope, projectRef, hubCall]);

  const go = (to: Switch) => {
    setPending(null);
    setEcho(null);
    setScope(to.scope);
    setSelected(to.id);
  };
  const request = (to: Switch) => {
    if (scopeKey(to.scope) === sk && to.id === selected) return;
    if (dirty) setPending(to);
    else go(to);
  };

  // A link from elsewhere (the row on Instructions, the palette, an old link to one prompt): open that prompt and
  // scope, asking first if it would drop a draft. Only a change of the route is a request; the page's own state
  // changes are not.
  const routeKey = `${route.prompt ?? ""}|${route.for ?? "hub"}`;
  const [seenRoute, setSeenRoute] = useState(routeKey);
  if (routeKey !== seenRoute) {
    setSeenRoute(routeKey);
    request({ scope: parseScope(route.for), id: route.prompt ?? selected });
  }

  /** The level a save or reset changes: an out-of-date edit's own, else the one this page edits. */
  const target = (p: PromptDetail) => (p.stale ? updateTarget(p, scope) : { scope: editScope(p, scope), projectRef });

  /** Saves `text`, written against the built-in the editor was filled with. */
  const save = (text: string) => {
    if (!d || !filled || busy) return;
    const to = target(d);
    const [typed, base] = [editor, filled.base];
    setBusy(true);
    setEcho(null);
    hubCall("prompt_set", { id: d.id, scope: to.scope, ...(to.scope === "project" && to.projectRef ? { projectRef: to.projectRef } : {}), text, base }).then(
      (o) => {
        setBusy(false);
        // The hub keeps an edit whose base is not today's built-in out of date, and answers with both changes to merge.
        const behind = !d.stale && base !== d.default.ref;
        setEcho({ ok: true, text: behind ? `${savedLine(o)} fleetd changed its built-in text meanwhile: both changes are below.` : savedLine(o) });
        setChecked({ text, warnings: o.warnings });
        // What was typed is saved, so the editor takes the hub's answer; anything typed since stays a draft.
        setFilled((f) => (f === null ? f : { ...f, text: typed }));
        refetchPrompts();
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  const reset = () => {
    if (!d || busy) return;
    const to = target(d);
    setBusy(true);
    setEcho(null);
    hubCall("prompt_set", { id: d.id, scope: to.scope, ...(to.scope === "project" && to.projectRef ? { projectRef: to.projectRef } : {}), reset: true }).then(
      () => {
        setBusy(false);
        // The editor takes whatever is in effect now, from the refetch.
        setFilled(null);
        setEcho({ ok: true, text: resetLine(to.scope, scopeName(scope, projects)) });
        refetchPrompts();
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  const screen = where === "hub" ? "settings.hub.prompts" : "settings.prompts";
  const toInstructions = () => {
    if (where === "hub") navigate({ id: "settings", tab: "hub.instructions" });
    else window.location.hash = formatRoute({ tab: "instructions", for: forKey });
  };
  const toList = <Back to="Built-in prompts" onClick={() => request({ scope, id: null })} />;
  const here = scopeName(scope, projects);

  if (!live || (where === "project" && scope.kind === "hub")) {
    return (
      <div className={s.scroll} data-screen={screen}>
        <div className={s.column}>
          <PageHead title="Built-in prompts" lead={<Back to="Instructions" onClick={toInstructions} />} />
          {live ? (
            <SettingsSection bare>
              <NoProject />
            </SettingsSection>
          ) : (
            <SettingsSection>
              <GroupNote>Not connected. Connect to a hub to see and edit the prompts it sends its agents.</GroupNote>
            </SettingsSection>
          )}
        </div>
      </div>
    );
  }

  // Each place shows only the edits it may change: a project's on its page, the hub-wide ones on the hub's.
  const level = where === "project" ? "project" : "global";
  const retired = (list.data?.orphans ?? []).filter((o) => o.scope === level);
  const gone = retired.find((o) => o.id === selected);
  const summary = list.data?.prompts?.find((p) => p.id === selected);
  const name = gone ? orphanTitle(gone) : d ? describe(d).name : summary ? describe(summary).name : "this prompt";
  const pendingWhy =
    pending && pending.id === null
      ? "Going back to the list drops them."
      : pending && pending.id !== selected
        ? "Opening another prompt drops them."
        : `Showing ${pending ? scopeName(pending.scope, projects) : here} drops them.`;

  return (
    <div className={s.scroll} data-screen={screen}>
      {selected === null ? (
        <div className={s.column}>
          <PageHead title="Built-in prompts" lead={<Back to="Instructions" onClick={toInstructions} />}>
            {where === "hub"
              ? "What fleetd itself tells every project's agents. An edit here replaces its text for every project without its own."
              : `What fleetd itself tells ${here}'s agents. An edit here replaces its text for ${here} only.`}
          </PageHead>
          {list.data === undefined ? (
            <SettingsSection>
              {list.isError ? (
                <SettingsRow
                  title={<Text tone="danger">{errorText(list.error)}</Text>}
                  label="Couldn't read the prompts"
                  control={
                    <Button size="sm" onClick={() => void list.refetch()}>
                      Try again
                    </Button>
                  }
                />
              ) : (
                <GroupNote>Loading prompts…</GroupNote>
              )}
            </SettingsSection>
          ) : (
            <PromptList
              prompts={list.data.prompts ?? []}
              retired={retired}
              level={level}
              unfolded={unfolded}
              onFold={(key) => setUnfolded((was) => new Set(was.has(key) ? [...was].filter((k) => k !== key) : [...was, key]))}
              onOpen={(id) => request({ scope, id })}
            />
          )}
        </div>
      ) : gone ? (
        <div className={cx(s.column, s.wide)}>
          <PageHead title={name} lead={toList}>{`${whyLine(gone)} ${orphanAdvice(gone)}`}</PageHead>
          <Retired
            o={gone}
            onOpen={(id) => request({ scope, id })}
            onDeleted={() => {
              refetchPrompts();
              go({ scope, id: null });
            }}
          />
        </div>
      ) : !d || !onScreen ? (
        <div className={cx(s.column, s.wide)}>
          <PageHead title={name} lead={toList} />
          <SettingsSection>
            {detail.isLoadingError && list.data !== undefined ? <GroupNote tone="danger">{errorText(detail.error)}</GroupNote> : <GroupNote>Loading…</GroupNote>}
          </SettingsSection>
        </div>
      ) : where === "project" && editScope(d, scope) === "global" ? (
        // A prompt with one text for the whole hub can't be edited for a project: its page shows it, read only.
        <div className={cx(s.column, s.wide)}>
          <PageHead title={name} lead={toList}>
            {`${describe(d).description} One text for every project on this hub: only the hub's owners and admins change it, from Hub › Every project › Instructions & memory.`}
          </PageHead>
          <SettingsSection bare>
            <div data-text="code">
              <Textarea aria-label={`${name}: text`} value={d.effective.text} readOnly minRows={10} maxRows={28} />
            </div>
          </SettingsSection>
        </div>
      ) : (
        <div className={cx(s.column, s.wide)}>
          <PageHead title={name} lead={toList}>
            {`${describe(d).description} ${effectLine(d, scope, scope.kind === "project" ? here : null)}`}
          </PageHead>
          <Editor
            d={d}
            name={name}
            edited={hasOverride(d, editScope(d, scope))}
            editor={editor}
            setEditor={setEditor}
            filledText={filled.text}
            checked={checked}
            busy={busy}
            echo={echo}
            onSave={save}
            onReset={() => setConfirmReset(true)}
          />
        </div>
      )}
      <ConfirmDiscard
        open={pending !== null}
        what={`${name} (${here})`}
        why={pendingWhy}
        onKeep={() => {
          setPending(null);
          // The link that asked already moved the hash; put it back on what is on screen, so the sidebar says so too.
          placeRoute(where, selected, forKey);
        }}
        onDiscard={() => pending && go(pending)}
      />
      <Dialog
        open={confirmReset}
        onOpenChange={(open) => !open && setConfirmReset(false)}
        title={`Reset ${name} to fleetd's built-in text?`}
        description={
          d && target(d).scope === "project"
            ? `Your edit for ${here} is deleted; ${here} gets the hub-wide text again. New agents get it; running ones keep theirs.`
            : "The hub-wide edit is deleted. Projects with their own edit keep it. New agents get the built-in text; running ones keep theirs."
        }
        footer={
          <>
            <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmReset(false);
                reset();
              }}
            >
              Reset
            </Button>
          </>
        }
      />
    </div>
  );
}

/** The same object for the same answer, so the page fills its editor once per answer. */
function withoutStale(raw: PromptDetail, seen: PromptDetail | null): PromptDetail {
  if (seen !== null && shown.get(seen) === raw) return seen;
  const { stale: _stale, ...rest } = raw;
  shown.set(rest, raw);
  return rest;
}
const shown = new WeakMap<PromptDetail, PromptDetail>();

/** The way back, in the window's top row before the page's name. */
function Back({ to, onClick }: { to: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      {`‹ ${to}`}
    </Button>
  );
}

/**
 * The page's one list: what is edited here first (an edit whose built-in text changed since says so, and so does one
 * of a prompt fleetd no longer sends), then the rest, each group folded until it is opened.
 */
function PromptList(props: {
  prompts: ReadonlyArray<PromptSummary>;
  retired: ReadonlyArray<RetiredPromptOverride>;
  level: "project" | "global";
  unfolded: ReadonlySet<string>;
  onFold: (group: string) => void;
  onOpen: (id: string) => void;
}) {
  const { edited, rest } = listed(props.prompts, props.level);
  const any = edited.length + props.retired.length > 0;
  const row = (r: CatalogRow, state?: { word: string; tone: "warning" }) => (
    <SettingsListRow key={r.summary.id} name={r.name} label={r.name} state={state} open={{ onClick: () => props.onOpen(r.summary.id) }}>
      <Text size="sm" tone="quiet">
        {r.description}
      </Text>
    </SettingsListRow>
  );
  return (
    <>
      {any ? (
        <SettingsSection title="Edited">
          <SettingsList label="Edited">
            {edited.map((r) => row(r, r.summary.stale ? { word: "built-in changed", tone: "warning" } : undefined))}
            {props.retired.map((o) => (
              <SettingsListRow
                key={`retired:${o.id}`}
                name={orphanTitle(o)}
                label={orphanTitle(o)}
                state={{ word: "no longer sent", tone: "quiet" }}
                open={{ onClick: () => props.onOpen(o.id) }}
              >
                <Text size="sm" tone="quiet">
                  {whyLine(o)}
                </Text>
              </SettingsListRow>
            ))}
          </SettingsList>
        </SettingsSection>
      ) : null}
      {rest.length > 0 ? (
        <SettingsSection title={any ? "Not edited" : undefined}>
          <SettingsList label={any ? "Not edited" : "Built-in prompts"}>
            {rest.map(({ group, rows }) => {
              const open = props.unfolded.has(group.key);
              return (
                <Fragment key={group.key}>
                  <SettingsListRow name={group.title} label={group.title} meta={String(rows.length)} open={{ onClick: () => props.onFold(group.key) }} expanded={open}>
                    <Text size="sm" tone="quiet">
                      {group.blurb}
                    </Text>
                  </SettingsListRow>
                  {open ? (
                    <SettingsList nested label={group.title}>
                      {rows.map((r) => row(r))}
                    </SettingsList>
                  ) : null}
                </Fragment>
              );
            })}
          </SettingsList>
        </SettingsSection>
      ) : null}
    </>
  );
}

/** An edit of a prompt fleetd no longer sends: what it said, where its intent could go, and Delete. */
function Retired(props: { o: RetiredPromptOverride; onOpen: (id: string) => void; onDeleted: () => void }) {
  const { o } = props;
  const hubCall = useHubCall();
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target = targetName(o);
  const remove = () => {
    setProblem(null);
    hubCall("prompt_set", { id: o.id, scope: o.scope, ...(o.scope === "project" && o.projectRef ? { projectRef: o.projectRef } : {}), reset: true }).then(
      props.onDeleted,
      (e: unknown) => setProblem(errorText(e)),
    );
  };
  return (
    <SettingsSection bare>
      <div data-text="code">
        <Textarea aria-label={`${orphanTitle(o)}: your text`} value={o.text} readOnly minRows={4} maxRows={28} />
      </div>
      <div className={s.actions}>
        {target && o.suggestedTarget ? <Button onClick={() => o.suggestedTarget && props.onOpen(o.suggestedTarget)}>{`Open ${target}`}</Button> : null}
        <Button onClick={() => setConfirm(true)}>Delete this edit</Button>
        <EchoLine echo={problem === null ? null : { ok: false, text: problem }} />
      </div>
      <Dialog
        open={confirm}
        onOpenChange={(open) => !open && setConfirm(false)}
        title={`Delete your edit to ${orphanTitle(o)}?`}
        description="fleetd doesn't send this prompt any more, so deleting it changes nothing agents are told. Copy the text first if you want to keep it."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                remove();
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}

/**
 * A prompt's text, with Save once it differs and Reset to the built-in once it is an edit. An edit whose built-in
 * text changed since it was made opens on both changes together, under what each side changed.
 */
function Editor(props: {
  d: PromptDetail;
  name: string;
  /** There is an edit at the level this page changes. */
  edited: boolean;
  editor: string;
  setEditor: (t: string) => void;
  filledText: string;
  checked: Checked | null;
  busy: boolean;
  echo: Echo | null;
  onSave: (text: string) => void;
  onReset: () => void;
}) {
  const { d, editor, busy } = props;
  const stale = d.stale;
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const el = area.current;
    const { value, caret } = insertAt(editor, el?.selectionStart ?? editor.length, el?.selectionEnd ?? editor.length, token(name));
    props.setEditor(value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };
  const dirty = editor !== props.filledText;

  return (
    <SettingsSection bare>
      {stale ? (
        <>
          <Text tone="warning">fleetd changed its built-in text since this edit was made. Your text stays in effect until you choose.</Text>
          {stale.base ? (
            <>
              <DiffLabel>What fleetd changed</DiffLabel>
              <DiffBlock before={stale.base.text} after={stale.current.text} label="What fleetd changed" />
              <DiffLabel>What you changed</DiffLabel>
              <DiffBlock before={stale.base.text} after={stale.yours.text} label="What you changed" />
            </>
          ) : (
            <>
              <DiffLabel>The new built-in text compared with yours (there is no record of the one your edit started from)</DiffLabel>
              <DiffBlock before={stale.current.text} after={stale.yours.text} label="The new built-in text compared with yours" />
            </>
          )}
          <DiffLabel>Both changes together. Edit before you save.</DiffLabel>
          {hasConflictMarkers(editor) ? (
            <div className={s.warning}>
              <Dot color="var(--warning)" />
              <Text>Both changed the same lines. Keep one side between the &lt;&lt;&lt;&lt;&lt;&lt;&lt; and &gt;&gt;&gt;&gt;&gt;&gt;&gt; markers; left in, they are sent as written.</Text>
            </div>
          ) : null}
        </>
      ) : null}
      {/* The prompt exactly as sent, markdown and placeholders included: a code view to the QA text rule. */}
      <div data-text="code">
        <Textarea
          ref={area}
          aria-label={stale ? "Both changes together" : `${props.name}: text`}
          value={editor}
          minRows={10}
          maxRows={stale ? 20 : 28}
          placeholder="An empty prompt can't be saved."
          onChange={(e) => props.setEditor(e.target.value)}
        />
      </div>
      <Warnings text={editor} checked={props.checked} />
      {stale ? (
        <div className={s.actions}>
          <Button variant="primary" disabled={busy || editor.trim() === ""} onClick={() => props.onSave(editor)}>
            {busy ? "Saving…" : "Save both changes"}
          </Button>
          <Button disabled={busy} title="Keeps your text as it is, now up to date with the new built-in text" onClick={() => props.onSave(stale.yours.text)}>
            Keep mine
          </Button>
          <Button disabled={busy} onClick={props.onReset}>
            Use the new built-in
          </Button>
          <EchoLine echo={props.echo} />
        </div>
      ) : dirty || busy || props.edited || props.echo ? (
        <div className={s.actions}>
          {/* Save shows once there is a change to save. */}
          {dirty || busy ? (
            <>
              <Button variant="primary" disabled={!canSave(editor, d.effective.text, busy)} onClick={() => props.onSave(editor)}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => props.setEditor(props.filledText)}>
                Discard changes
              </Button>
            </>
          ) : null}
          {props.edited ? (
            <Button disabled={busy} onClick={props.onReset}>
              Reset to the built-in
            </Button>
          ) : null}
          <EchoLine echo={props.echo} />
        </div>
      ) : null}
      {d.placeholders.length > 0 ? (
        <div className={s.placeholders}>
          <Text size="xs" tone="quiet">
            fleetd fills these in:
          </Text>
          {d.placeholders.map((p) => (
            <Tooltip key={p.name} content={`${p.description}${p.required ? " Required." : ""} Click to insert it at the cursor.`}>
              <button type="button" className={s.chipButton} onClick={() => insert(p.name)} aria-label={`Insert the ${p.name} placeholder`}>
                <code>{token(p.name)}</code>
              </button>
            </Tooltip>
          ))}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function DiffLabel({ children }: { children: string }) {
  return (
    <Text size="sm" strong tone="quiet">
      {children}
    </Text>
  );
}

function EchoLine({ echo }: { echo: Echo | null }) {
  if (!echo) return null;
  return (
    <div className={s.echo} role="status">
      <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
        {echo.text}
      </Text>
    </div>
  );
}

/** What a save of `text` would lose: the dry run's warnings once it answered, the last ones known until then. Quiet when there are none. */
function Warnings({ text, checked }: { text: string; checked: Checked | null }) {
  const warnings = text.trim() === "" ? [] : (checked?.warnings ?? []);
  return (
    <div className={s.warnings} role="status">
      {text.trim() === "" ? (
        <Text size="xs" tone="warning">
          An empty prompt can&apos;t be saved.
        </Text>
      ) : null}
      {warnings.map((w, ix) => (
        <div key={ix} className={s.warning}>
          <Dot color="var(--warning)" />
          <Text>{warningLine(w)}</Text>
        </div>
      ))}
      {warnings.length > 0 ? (
        <Text size="xs" tone="quiet">
          Warnings never stop a save.
        </Text>
      ) : null}
    </div>
  );
}
