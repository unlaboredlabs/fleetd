// Custom instructions, appended to every lead's and task's first message (workers and reviewers too) under "Custom
// instructions from the human": the hub-wide text, then the project's. Settings → Projects › Instructions & memory
// edits one project's;
// Settings › Hub › Every project edits the one for every project (HubInstructions), which only owners and admins change
// (D209). Saved with prompt_set on the registry id `instructions`, and pinned per session like every prompt.
import { useEffect, useState } from "react";
import { Button, Field, Text, Textarea } from "../../ui";
import { INSTRUCTIONS, type ProjectRef, type PromptScope } from "./contracts";
import { parseScope, projectRefOf, scopeKey, shownDraft, type Draft, type Scope } from "./editor";
import { useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { Memory } from "./Memory";
import { MemoryRefreshSetting } from "./Projects";
import { NoProject, PageHead, PagePart, scopeName, useProjects } from "./parts";
import { replaceRoute, type SettingsRoute } from "./route";
import s from "./settings.module.css";

type Echo = { ok: boolean; text: string };

/** Unsaved instructions by "hub" or "<machine>/<project>", kept while their page is closed. */
const drafts = new Map<string, Draft>();

const fill = (d: Draft | null, saved: string): Draft => (d === null || d.text === d.from ? { from: saved, text: saved } : { from: saved, text: d.text });

/**
 * One level's text, as the hub has it, with its draft and Save: the hub-wide one (`project` null) or a project's.
 * Another project's draft is never kept.
 */
function useText(project: Scope | null, scope: PromptScope) {
  const live = useLive();
  const ref = project ? projectRefOf(project) : undefined;
  const key = project ? scopeKey(project) : "hub";
  const read = useToolQuery("prompt_get", { id: INSTRUCTIONS, ...(ref ? { projectRef: ref } : {}) }, { enabled: live && (scope === "global" || ref !== undefined) });
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [own, setOwnState] = useState<{ key: string; draft: Draft } | null>(() => {
    const kept = drafts.get(key);
    return kept === undefined ? null : { key, draft: kept };
  });
  // A draft outlives its page: picking another project and coming back finds it.
  const setOwn = (next: { key: string; draft: Draft }) => {
    if (next.draft.text === next.draft.from) drafts.delete(next.key);
    else drafts.set(next.key, next.draft);
    setOwnState(next);
  };
  const [synced, setSynced] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const d = read.data?.prompt ?? null;
  if (d && d !== synced) {
    setSynced(d);
    const saved = (scope === "global" ? d.global?.text : d.project?.text) ?? "";
    setOwn({ key, draft: fill(own?.key === key ? own.draft : null, saved) });
  }
  const draft = own?.key === key ? own.draft : null;
  const dirty = draft !== null && draft.text !== draft.from;
  const save = (whose: string) => {
    if (!d || !draft || busy) return;
    const text = draft.text;
    setBusy(true);
    setEcho(null);
    hubCall("prompt_set", { id: INSTRUCTIONS, scope, ...(scope === "project" && ref ? { projectRef: ref } : {}), text, base: d.default.ref }).then(
      () => {
        setBusy(false);
        setEcho({ ok: true, text: `Saved ${whose}. New agents get them; a lead gets them at its next restart.` });
        setOwn({ key, draft: { from: text, text } });
        refetch(["prompt_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  return {
    live,
    read,
    ready: d !== null,
    // Until the hub has answered for this connection, only what you typed and haven't saved is shown; an untouched
    // text is the last connection's answer, not the hub's now, so it shows as loading and can't be edited.
    shown: shownDraft(d !== null, draft),
    dirty,
    busy,
    echo,
    setEcho,
    edit: (text: string) => setOwn({ key, draft: { from: draft?.from ?? "", text } }),
    discard: () => draft && setOwn({ key, draft: { ...draft, text: draft.from } }),
    save,
  };
}

type TextState = ReturnType<typeof useText>;

/** The textarea, Save and Discard changes, and what the last save said. */
function Editor({ t, label, placeholder, whose }: { t: TextState; label: string; placeholder: string; whose: string }) {
  return (
    <>
      <Textarea
        aria-label={label}
        value={t.shown?.text ?? ""}
        disabled={!t.ready}
        minRows={6}
        maxRows={24}
        placeholder={t.ready ? placeholder : "Loading…"}
        onChange={(e) => t.edit(e.target.value)}
      />
      <div className={s.actions}>
        <Button variant="primary" disabled={!t.ready || !t.dirty || t.busy} onClick={() => t.save(whose)}>
          {t.busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" disabled={!t.dirty} onClick={t.discard}>
          Discard changes
        </Button>
      </div>
      <div role="status">
        {t.echo ? (
          <Text size="xs" tone={t.echo.ok ? "quiet" : "danger"}>
            {t.echo.text}
          </Text>
        ) : null}
      </div>
    </>
  );
}

function LoadProblem({ t }: { t: TextState }) {
  if (!t.read.isLoadingError) return null;
  return (
    <div className={s.inline}>
      <Text tone="danger">{errorText(t.read.error)}</Text>
      <Button onClick={() => void t.read.refetch()}>Try again</Button>
    </div>
  );
}

/** Settings › Hub › Every project: the instructions every project's agents get, before a project's own. */
export function HubInstructions() {
  const t = useText(null, "global");
  if (!t.live) return <Text tone="quiet">Connect to a hub to see and change this.</Text>;
  return (
    <div className={s.stack}>
      <LoadProblem t={t} />
      <Field label="Every project" description="Added to every agent's first message on this hub, the lead's too, before a project's own.">
        <Editor t={t} label="Instructions for every project" placeholder="e.g. Keep pull requests under 400 changed lines." whose="for every project" />
      </Field>
    </div>
  );
}

/**
 * Settings → Projects › Instructions & memory: the project's own instructions, sent to its agents after the hub-wide
 * ones, then what its leads remember (Memory.tsx), and whether the lead tidies that every night.
 */
export function Instructions({ route }: { route: SettingsRoute }) {
  const projects = useProjects();
  const shown = route.for ? parseScope(route.for) : null;
  const project = shown?.kind === "project" ? shown : null;
  const t = useText(project, "project");

  useEffect(() => {
    replaceRoute({ tab: "instructions", for: route.for });
  }, [route.for]);

  const name = project ? scopeName(project, projects) : null;
  return (
    <div className={s.scroll} data-screen="settings.instructions">
      <div className={s.column}>
        <PageHead title="Instructions & memory">What {name ?? "a project"}&apos;s agents are told, and what its leads remember.</PageHead>
        <PagePart title="Instructions" reveal="instructions" intro="Added to the project's agents' first message, the lead's too, after the hub-wide ones.">
          {!t.live ? (
            <Text tone="quiet">Not connected. Connect to a hub to add instructions for its agents.</Text>
          ) : project === null ? (
            <NoProject />
          ) : (
            <div className={s.stack}>
              <LoadProblem t={t} />
              <Editor t={t} label={`Instructions for ${name ?? "this project"}`} placeholder="e.g. Use pnpm, not npm." whose={`for ${name ?? "this project"}`} />
            </div>
          )}
        </PagePart>
        <Memory project={project} />
        {project === null ? null : <Refresh projectRef={project.ref} />}
      </div>
    </div>
  );
}

/** The nightly refresh's switch, read with the project's settings. */
function Refresh({ projectRef }: { projectRef: ProjectRef }) {
  const read = useToolQuery("project_settings_get", { machineId: projectRef.machineId, projectId: projectRef.projectId });
  const settings = read.data?.settings;
  return settings === undefined ? null : <MemoryRefreshSetting settings={settings} />;
}
