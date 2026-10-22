// Settings → Prompts: every text fleetd sends a model, each editable hub-wide or for one project. The prompts are
// listed in the settings sidebar (SettingsSidebar), so the editor has the window's width. Warnings come from the
// hub's dry run as you type and never block a save. A running session keeps the text it started with.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Dot, IdChip, Tab, TabList, TabPanel, Tabs, Text, Textarea, copyText, textClass } from "../../ui";
import { describe } from "./catalog";
import {
  type ProjectRef,
  type ProjectSummary,
  type PromptDetail,
  type PromptScope,
  type PromptWarning,
  type RetiredPromptOverride,
} from "./contracts";
import { DiffBlock } from "./DiffBlock";
import { counts, diffLines, sameProse } from "./diff";
import {
  canSave,
  editScope,
  effectLines,
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
  syncedMerge,
  token,
  updateTarget,
  warningLine,
  type Filled,
  type Scope,
} from "./editor";
import { errorText, useHubCall, useLive, useRead, useRefetch } from "./hub";
import { ConfirmDiscard, PageHead, ScopeSelect, scopeName, useProjects } from "./parts";
import { oldPromptName, orphanAdvice, orphanHeadline, targetName, whyLine } from "./orphans";
import { replaceRoute, type SettingsRoute, type View } from "./route";
import s from "./settings.module.css";

type Switch = { scope: Scope; id: string | null };
type Echo = { ok: boolean; text: string };
/** Which reset the confirm is for: the Edit tab's level, or the stale override's (Update → Use the new default). */
type ResetFor = "edit" | "update";

/** The unsaved draft, kept while Settings is closed or another tab is open, so leaving does not lose it. */
let kept: { filled: Filled; text: string; mergedFilled: Filled | null; merged: string } | null = null;

export function Prompts({ route }: { route: SettingsRoute }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const refetchPrompts = () => refetch(["prompts_list", "prompt_get"]);
  const projects = useProjects();

  // A kept draft for another prompt or scope opens first, and the route waits behind the discard confirm.
  const [start] = useState(() => startOn(kept, route));
  const [scope, setScope] = useState<Scope>(start.scope);
  const [selected, setSelected] = useState<string | null>(start.id);
  const [pending, setPending] = useState<Switch | null>(start.ask);
  const sk = scopeKey(scope);
  const projectRef = projectRefOf(scope);

  const scoped = projectRef ? { projectRef } : {};
  const [list] = useRead("prompts_list", scoped, live);
  const [detail] = useRead("prompt_get", { id: selected ?? "", ...scoped }, live && selected !== null);

  const [editor, setEditor] = useState(() => kept?.text ?? "");
  const [filled, setFilled] = useState<Filled | null>(() => kept?.filled ?? null);
  const [merged, setMerged] = useState(() => kept?.merged ?? "");
  const [mergedFilled, setMergedFilled] = useState<Filled | null>(() => kept?.mergedFilled ?? null);
  const [view, setView] = useState<View>(route.view);
  const [seen, setSeen] = useState<PromptDetail | null>(null);
  const [checked, setChecked] = useState<{ text: string; warnings: ReadonlyArray<PromptWarning> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [confirmReset, setConfirmReset] = useState<ResetFor | null>(null);
  /** A save went out against an older default: show the 3-way update as soon as the hub answers with it. */
  const [toUpdate, setToUpdate] = useState(false);

  // Fill the editors from what the hub sent for the prompt and scope on screen (see `synced`), during render so the
  // first paint of a new prompt already shows its text.
  const d = detail.state === "ready" ? detail.value : null;
  if (d && d !== seen) {
    setSeen(d);
    const next = synced(filled, d, sk, editor);
    if (next.refill) {
      setEditor(next.filled.text);
      setChecked({ text: next.filled.text, warnings: d.warnings });
    }
    setFilled(next.filled);
    const m = syncedMerge(mergedFilled, d, sk, merged);
    if (m) {
      if (m.refill) setMerged(m.filled.text);
      setMergedFilled(m.filled);
      if (toUpdate) {
        setToUpdate(false);
        setView("update");
      }
    } else {
      setMergedFilled(null);
      if (view === "update") setView("edit");
    }
  }
  const onScreen = d !== null && filled?.id === d.id && filled.scope === sk;
  // Known without the hub's answer, so a switch asked for before the prompt loads still asks first.
  const mine = (f: Filled | null): f is Filled => f !== null && f.id === selected && f.scope === sk;
  const dirty = (mine(filled) && isDirty(filled, editor)) || (mine(mergedFilled) && isDirty(mergedFilled, merged));

  useEffect(() => {
    kept = filled ? { filled, text: editor, mergedFilled, merged } : null;
  }, [filled, editor, mergedFilled, merged]);

  useEffect(() => {
    replaceRoute({ tab: "prompts", prompt: selected, for: scope.kind === "project" ? sk : null, view });
  }, [selected, scope.kind, sk, view]);

  // The dry run, after a pause in typing: what saving this text would warn about.
  const editorText = view === "update" ? merged : editor;
  useEffect(() => {
    if (!d || !onScreen || editorText.trim() === "" || checked?.text === editorText) return;
    const scopeOut = editScope(d, scope);
    const timer = window.setTimeout(() => {
      hubCall("prompt_set", {
        id: d.id,
        scope: scopeOut,
        ...(scopeOut === "project" && projectRef ? { projectRef } : {}),
        text: editorText,
        dryRun: true,
      }).then(
        (o) => setChecked({ text: editorText, warnings: o.warnings }),
        // A hub without the dry run: the save still answers with the warnings.
        () => undefined,
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [d, onScreen, editorText, checked?.text, scope, projectRef, hubCall]);

  const go = (to: Switch) => {
    setPending(null);
    setEcho(null);
    setScope(to.scope);
    if (to.id !== selected) {
      setSelected(to.id);
      setView("edit");
    }
  };
  const request = (to: Switch) => {
    if (scopeKey(to.scope) === sk && to.id === selected) return;
    if (dirty) setPending(to);
    else go(to);
  };

  // A link from elsewhere (the palette, the sidebar, a notice): open that prompt and scope, asking first if it would
  // drop a draft. Only a change of the route is a request; the page's own state changes are not.
  const routeKey = `${route.prompt ?? ""}|${route.for ?? "hub"}`;
  const [seenRoute, setSeenRoute] = useState(routeKey);
  if (routeKey !== seenRoute) {
    setSeenRoute(routeKey);
    request({ scope: parseScope(route.for), id: route.prompt ?? selected });
  }

  /** Saves `text` at `target`, written against the default `base` (null: the one shipped now). */
  const save = (text: string, target: { scope: PromptScope; projectRef?: ProjectRef | undefined }, base: string | null) => {
    if (!d || busy) return;
    setBusy(true);
    setEcho(null);
    hubCall("prompt_set", {
      id: d.id,
      scope: target.scope,
      ...(target.scope === "project" && target.projectRef ? { projectRef: target.projectRef } : {}),
      text,
      ...(base !== null ? { base } : {}),
    }).then(
      (o) => {
        setBusy(false);
        // The hub keeps an edit whose base is not today's default stale, and answers with both changes to merge.
        const behind = base !== null && base !== d.default.ref;
        setEcho({ ok: true, text: behind ? `${savedLine(o)} fleetd changed its default meanwhile: merge both changes below.` : savedLine(o) });
        setChecked({ text, warnings: o.warnings });
        setToUpdate(behind);
        if (view === "update") setView("edit");
        refetchPrompts();
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  const saveEdit = (text: string) => {
    if (d && filled) save(text, { scope: editScope(d, scope), projectRef }, filled.base);
  };
  const saveUpdate = (text: string) => {
    // The default the merge was written against: if fleetd's moved again meanwhile, the save comes back stale.
    if (d?.stale) save(text, updateTarget(d, scope), mine(mergedFilled) ? mergedFilled.base : d.stale.current.ref);
  };

  const reset = (which: ResetFor) => {
    if (!d || busy) return;
    const target = which === "update" ? updateTarget(d, scope) : { scope: editScope(d, scope), projectRef };
    setBusy(true);
    setEcho(null);
    hubCall("prompt_reset", {
      id: d.id,
      scope: target.scope,
      ...(target.scope === "project" && target.projectRef ? { projectRef: target.projectRef } : {}),
    }).then(
      () => {
        setBusy(false);
        // The editor takes whatever is in effect now, from the refetch.
        setFilled(null);
        setEcho({ ok: true, text: resetLine(target.scope, scopeName(scope, projects)) });
        setView("edit");
        refetchPrompts();
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  if (!live) {
    return (
      <div className={s.scroll} data-screen="settings.prompts">
        <div className={s.detail}>
          <PageHead title="Prompts" />
          <Text tone="quiet">Not connected. Connect to a hub to see and edit the prompts it sends its agents.</Text>
        </div>
      </div>
    );
  }

  const here = scopeName(scope, projects);
  const pendingWhy =
    pending && pending.id !== selected ? "Opening another prompt drops them." : `Showing ${pending ? scopeName(pending.scope, projects) : here} drops them.`;
  const listed = list.state === "ready" ? list.value.prompts.find((p) => p.id === selected) : undefined;
  const orphans = list.state === "ready" ? list.value.orphans : [];
  const name = d ? describe(d).name : listed ? describe(listed).name : "this prompt";
  const resetScope = d && confirmReset ? (confirmReset === "update" ? updateTarget(d, scope).scope : editScope(d, scope)) : null;

  return (
    <div className={s.scroll} data-screen={view === "edit" ? "settings.prompts" : `settings.prompts.${view}`}>
      <div className={s.detail}>
        <PageHead
          title="Prompts"
          aside={
            <div className={s.scopePick}>
              <label htmlFor="prompts-scope" className={textClass({ tone: "quiet" })}>
                Texts for
              </label>
              <ScopeSelect
                id="prompts-scope"
                className={s.scopeSelect}
                value={scope}
                hubWide="Hub-wide"
                projects={projects}
                onChange={(next) => request({ scope: next, id: selected })}
              />
            </div>
          }
        >
          {scope.kind === "hub"
            ? "Hub-wide texts go to every project without an edit of its own. Running sessions keep the text they started with."
            : `${here}'s own texts; prompts it hasn't edited use the hub-wide text. Running sessions keep the text they started with.`}
        </PageHead>
        {orphans.length > 0 ? (
          <Orphans orphans={orphans} projects={projects} onOpen={(id) => request({ scope, id })} onDeleted={refetchPrompts} />
        ) : null}
        {selected === null ? (
          <div className={s.stack}>
            <Text strong>Pick a prompt</Text>
            <Text tone="quiet">Each one says when fleetd sends it. Edit it here; fleetd's default stays one click away.</Text>
            <Text size="xs" tone="quiet">
              What the lead hears when a PR merges, a task ends or a check fails is a fixed event line that fleetd writes, so it isn't a
              prompt and isn't listed.
            </Text>
            <div>
              <Button size="sm" variant="ghost" onClick={() => void window.fleetd.openExternal(EVENTS_DOC)}>
                How event lines read
              </Button>
            </div>
          </div>
        ) : detail.state === "failed" ? (
          <Text tone="danger">{detail.message}</Text>
        ) : !d || !onScreen ? (
          <Text tone="quiet">Loading…</Text>
        ) : (
          <Detail
            d={d}
            scope={scope}
            scopeLabel={here}
            view={view}
            setView={setView}
            editor={editor}
            setEditor={setEditor}
            filledText={filled.text}
            defaultMoved={filled.base !== null && filled.base !== d.default.ref && !d.stale && editor !== filled.text}
            noBase={filled.base === null}
            merged={merged}
            setMerged={setMerged}
            checked={checked}
            busy={busy}
            echo={echo}
            onSave={saveEdit}
            onSaveUpdate={saveUpdate}
            onReset={() => setConfirmReset("edit")}
            onUseDefault={() => setConfirmReset("update")}
          />
        )}
      </div>
      <ConfirmDiscard
        open={pending !== null}
        what={`${name} (${here})`}
        why={pendingWhy}
        onKeep={() => {
          setPending(null);
          // The link that asked already moved the hash; put it back on what is on screen, so the sidebar says so too.
          replaceRoute({ tab: "prompts", prompt: selected, for: scope.kind === "project" ? sk : null, view });
        }}
        onDiscard={() => pending && go(pending)}
      />
      <Dialog
        open={confirmReset !== null}
        onOpenChange={(open) => !open && setConfirmReset(null)}
        title={confirmReset === "update" ? `Use fleetd's new default for ${name}?` : `Reset ${name} to fleetd's default?`}
        description={
          resetScope === "project"
            ? `Your edit for ${here} is deleted; ${here} gets the hub-wide text again. New sessions get it; running ones keep theirs.`
            : "Your hub-wide edit is deleted. Projects with their own edit keep it. New sessions get the default; running ones keep theirs."
        }
        footer={
          <>
            <Button onClick={() => setConfirmReset(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const which = confirmReset;
                setConfirmReset(null);
                if (which) reset(which);
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

const EVENTS_DOC = "https://fleetd.sh/docs/what-agents-are-told#wake-events";

/** Edits of prompts fleetd no longer has: what each said, where it could go, and Delete. */
function Orphans(props: {
  orphans: ReadonlyArray<RetiredPromptOverride>;
  projects: ReadonlyArray<ProjectSummary> | undefined;
  onOpen: (id: string) => void;
  onDeleted: () => void;
}) {
  const hubCall = useHubCall();
  const [shownText, setShownText] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RetiredPromptOverride | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [echo, setEcho] = useState<Echo | null>(null);
  const key = (o: RetiredPromptOverride) => `${o.id}|${o.scope}|${o.projectRef?.machineId ?? ""}/${o.projectRef?.projectId ?? ""}`;
  const remove = (o: RetiredPromptOverride) => {
    setEcho(null);
    hubCall("prompt_reset", { id: o.id, scope: o.scope, ...(o.scope === "project" && o.projectRef ? { projectRef: o.projectRef } : {}) }).then(
      () => {
        setEcho({ ok: true, text: `Deleted your edit to ${oldPromptName(o)}.` });
        props.onDeleted();
      },
      (e: unknown) => setEcho({ ok: false, text: errorText(e) }),
    );
  };
  return (
    <section className={s.orphans} aria-label="Edits that no longer apply">
      {props.orphans.map((o) => {
        const k = key(o);
        const target = targetName(o);
        const open = shownText === k;
        return (
          <div key={k} className={s.orphan}>
            <div className={s.orphanHead}>
              <Dot color="var(--warning)" />
              <Text strong>{orphanHeadline(o, props.projects)}</Text>
            </div>
            <Text size="xs" tone="quiet">{`${whyLine(o)} ${orphanAdvice(o)}`}</Text>
            {open ? (
              <pre className={s.orphanText} data-text="code">
                {o.text}
              </pre>
            ) : null}
            <div className={s.actions}>
              <Button size="sm" onClick={() => setShownText(open ? null : k)}>
                {open ? "Hide your text" : "Show your text"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void copyText(o.text).then((ok) => setCopied(ok ? k : null));
                }}
              >
                {copied === k ? "Copied" : "Copy your text"}
              </Button>
              {target && o.suggestedTarget ? (
                <Button size="sm" variant="ghost" onClick={() => o.suggestedTarget && props.onOpen(o.suggestedTarget)}>
                  {`Open ${target}`}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setConfirm(o)}>
                Delete this edit
              </Button>
            </div>
          </div>
        );
      })}
      {echo ? (
        <div role="status">
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </div>
      ) : null}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm ? `Delete your edit to ${oldPromptName(confirm)}?` : ""}
        description="fleetd doesn't send this prompt any more, so deleting it changes nothing agents are told. Copy the text first if you want to keep it."
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const o = confirm;
                setConfirm(null);
                if (o) remove(o);
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

function Detail(props: {
  d: PromptDetail;
  scope: Scope;
  scopeLabel: string;
  view: View;
  setView: (v: View) => void;
  editor: string;
  setEditor: (t: string) => void;
  filledText: string;
  merged: string;
  setMerged: (t: string) => void;
  checked: { text: string; warnings: ReadonlyArray<PromptWarning> } | null;
  busy: boolean;
  echo: Echo | null;
  /** The draft was written against an older default than the one the hub ships now. */
  defaultMoved: boolean;
  /** The text in effect is a stale edit with no record of its base: only the Update view can save it. */
  noBase: boolean;
  onSave: (text: string) => void;
  onSaveUpdate: (text: string) => void;
  onReset: () => void;
  onUseDefault: () => void;
}) {
  const { d, scope, editor, busy } = props;
  const row = describe(d);
  const { inEffect, lands } = effectLines(d, scope, scope.kind === "project" ? props.scopeLabel : null);
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
    <>
      <div className={s.head}>
        <IdChip label={row.name} id={d.id} kind="prompt" strong />
        <Text tone="quiet">{row.description}</Text>
        <Text size="xs" tone="quiet">
          {`${inEffect} ${lands}`}
        </Text>
      </div>

      {d.stale && props.view !== "update" ? (
        <div className={s.notice}>
          <span className={s.noticeText}>
            <Dot color="var(--warning)" />
            <Text>fleetd's default changed since you edited this. Your text stays in effect until you save it again.</Text>
          </span>
          <Button onClick={() => props.setView("update")}>Review the update</Button>
        </div>
      ) : null}

      <Tabs value={props.view} onValueChange={(v) => props.setView(v === "compare" || v === "update" ? v : "edit")}>
        <TabList aria-label="Prompt views">
          <Tab value="edit">Edit</Tab>
          <Tab value="compare">Compare with default</Tab>
          {d.stale ? <Tab value="update">Update</Tab> : null}
        </TabList>

        <TabPanel value="edit" className={s.panel}>
          {props.defaultMoved ? (
            <div className={s.warning}>
              <Dot color="var(--warning)" />
              <Text>fleetd changed this prompt's default while you were editing. Saving keeps your text and then shows both changes to merge.</Text>
            </div>
          ) : null}
          {props.noBase ? (
            <div className={s.warning}>
              <Dot color="var(--warning)" />
              <Text>fleetd's default changed since this edit, and there is no record of the default it started from. Save it from Update.</Text>
            </div>
          ) : null}
          {/* The prompt exactly as sent, markdown and placeholders included: a code view to the QA text rule. */}
          <div data-text="code">
            <Textarea
              ref={area}
              aria-label={`${row.name}: text`}
              value={editor}
              minRows={10}
              maxRows={40}
              placeholder="An empty prompt can't be saved."
              onChange={(e) => props.setEditor(e.target.value)}
            />
          </div>
          <Warnings text={editor} checked={props.checked} />
          <div className={s.actions}>
            <Button variant="primary" disabled={props.noBase || !canSave(editor, d.effective.text, busy)} onClick={() => props.onSave(editor)}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button disabled={busy || !hasOverride(d, editScope(d, scope))} onClick={props.onReset}>
              Reset to default
            </Button>
            <Button variant="ghost" disabled={busy || !dirty} onClick={() => props.setEditor(props.filledText)}>
              Discard changes
            </Button>
            <EchoLine echo={props.echo} />
          </div>
          {d.placeholders.length > 0 ? (
            <div className={s.stack}>
              <Text size="xs" strong tone="quiet">
                Placeholders: fleetd fills these in. Click one to insert it at the cursor.
              </Text>
              <div className={s.placeholders}>
                {d.placeholders.map((p) => {
                  const present = editor.includes(token(p.name));
                  return (
                    <PlaceholderRow
                      key={p.name}
                      name={p.name}
                      status={p.required ? (present ? "required" : "required, missing") : "optional"}
                      missing={p.required && !present}
                      description={p.description}
                      onInsert={() => insert(p.name)}
                    />
                  );
                })}
              </div>
            </div>
          ) : null}
        </TabPanel>

        <TabPanel value="compare" className={s.panel}>
          <Compare base={d.default.text} text={editor} />
        </TabPanel>

        {d.stale ? (
          <TabPanel value="update" className={s.panel}>
            <Update
              d={d}
              merged={props.merged}
              setMerged={props.setMerged}
              checked={props.checked}
              busy={busy}
              echo={props.echo}
              scope={scope}
              scopeLabel={props.scopeLabel}
              onSave={props.onSaveUpdate}
              onUseDefault={props.onUseDefault}
            />
          </TabPanel>
        ) : null}
      </Tabs>
    </>
  );
}

function PlaceholderRow(props: { name: string; status: string; missing: boolean; description: string; onInsert: () => void }) {
  return (
    <div className={s.placeholder}>
      <button type="button" className={s.chipButton} onClick={props.onInsert} aria-label={`Insert the ${props.name} placeholder`}>
        <code>{token(props.name)}</code>
      </button>
      <Text size="xs" tone={props.missing ? "warning" : "quiet"} strong={props.missing}>
        {props.status}
      </Text>
      <Text size="xs" tone="quiet">
        {props.description}
      </Text>
    </div>
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

/** The warnings for `text`: the dry run's once it answered for this exact text, else the last ones known. */
function Warnings({ text, checked }: { text: string; checked: { text: string; warnings: ReadonlyArray<PromptWarning> } | null }) {
  if (text.trim() === "") {
    return (
      <Text size="xs" tone="warning">
        An empty prompt can't be saved. Reset to default brings fleetd's text back.
      </Text>
    );
  }
  const current = checked?.text === text;
  const warnings = checked?.warnings ?? [];
  if (warnings.length === 0) {
    return (
      <div role="status">
        <Text size="xs" tone="quiet">
          {current ? "No warnings." : "Checking…"}
        </Text>
      </div>
    );
  }
  return (
    <div className={s.warnings} role="status">
      {warnings.map((w, ix) => (
        <div key={ix} className={s.warning}>
          <Dot color="var(--warning)" />
          <Text>{warningLine(w)}</Text>
        </div>
      ))}
      <Text size="xs" tone="quiet">
        {current ? "Warnings never stop a save." : "Checking the latest change… Warnings never stop a save."}
      </Text>
    </div>
  );
}

function Compare({ base, text }: { base: string; text: string }) {
  const n = useMemo(() => counts(diffLines(base, text)), [base, text]);
  if (text === base) return <Text tone="quiet">Same as fleetd's default.</Text>;
  if (sameProse(base, text)) return <Text tone="quiet">Same words as fleetd's default; only the line breaks or spacing differ.</Text>;
  return (
    <>
      <Text size="xs" tone="quiet">
        {`fleetd's default → the text in the editor: ${n.added} ${n.added === 1 ? "line" : "lines"} added, ${n.removed} removed.`}
      </Text>
      <DiffBlock before={base} after={text} label="fleetd's default compared with the text in the editor" />
    </>
  );
}

function Update(props: {
  d: PromptDetail;
  scope: Scope;
  scopeLabel: string;
  merged: string;
  setMerged: (t: string) => void;
  checked: { text: string; warnings: ReadonlyArray<PromptWarning> } | null;
  busy: boolean;
  echo: Echo | null;
  onSave: (text: string) => void;
  onUseDefault: () => void;
}) {
  const stale = props.d.stale;
  if (!stale) return null;
  const conflicts = hasConflictMarkers(props.merged);
  const level =
    updateTarget(props.d, props.scope).scope === "project"
      ? `These buttons change ${props.scopeLabel}'s own edit.`
      : props.scope.kind === "project"
        ? `The out-of-date edit is your hub-wide one, which ${props.scopeLabel} uses: these buttons change it for every project without its own edit.`
        : "These buttons change your hub-wide edit, used by every project without its own.";
  return (
    <>
      <Text tone="quiet">{level}</Text>
      {stale.base ? (
        <>
          <Text size="xs" strong tone="quiet">
            What fleetd changed in its default
          </Text>
          <DiffBlock before={stale.base.text} after={stale.current.text} label="What fleetd changed in its default" />
          <Text size="xs" strong tone="quiet">
            What you changed
          </Text>
          <DiffBlock before={stale.base.text} after={stale.yours.text} label="What you changed" />
        </>
      ) : (
        <>
          <Text tone="quiet">This edit has no record of the default it started from, so only the new default and yours can be compared.</Text>
          <Text size="xs" strong tone="quiet">
            The new default compared with yours
          </Text>
          <DiffBlock before={stale.current.text} after={stale.yours.text} label="The new default compared with yours" />
        </>
      )}
      <Text size="xs" strong tone="quiet">
        Both changes together. Edit before you save.
      </Text>
      {conflicts ? (
        <div className={s.warning}>
          <Dot color="var(--warning)" />
          <Text>Both changed the same lines. Keep one side between the &lt;&lt;&lt;&lt;&lt;&lt;&lt; and &gt;&gt;&gt;&gt;&gt;&gt;&gt; markers; left in, they are sent as written.</Text>
        </div>
      ) : null}
      <div data-text="code">
        <Textarea
          aria-label="Both changes together"
          value={props.merged}
          minRows={10}
          maxRows={40}
          onChange={(e) => props.setMerged(e.target.value)}
        />
      </div>
      <Warnings text={props.merged} checked={props.checked} />
      <div className={s.actions}>
        <Button variant="primary" disabled={props.busy || props.merged.trim() === ""} onClick={() => props.onSave(props.merged)}>
          {props.busy ? "Saving…" : "Save both changes"}
        </Button>
        <Button disabled={props.busy} onClick={() => props.onSave(stale.yours.text)}>
          Keep mine
        </Button>
        <Button disabled={props.busy} onClick={props.onUseDefault}>
          Use the new default
        </Button>
        <EchoLine echo={props.echo} />
      </div>
      <Text size="xs" tone="quiet">
        Keep mine marks your text as up to date with this default. Use the new default deletes your edit at this level.
      </Text>
    </>
  );
}
