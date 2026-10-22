// Settings → Instructions: your own text, appended to every lead's and task's first message (workers, reviewers
// and judges too) under "Custom instructions from the human": the hub-wide text, then the project's. Saved with
// prompt_set on the registry id `instructions`, and pinned per session like every prompt.
import { useEffect, useState } from "react";
import { Button, Field, Separator, Text, Textarea } from "../../ui";
import { INSTRUCTIONS, type PromptDetail, type PromptScope } from "./contracts";
import { parseScope, projectRefOf, scopeKey, shownDraft, type Draft, type Scope } from "./editor";
import { errorText, useHubCall, useLive, useRead, useRefetch } from "./hub";
import { ConfirmDiscard, PageHead, ScopeSelect, scopeName, useProjects } from "./parts";
import { replaceRoute, type SettingsRoute } from "./route";
import s from "./settings.module.css";

type Echo = { ok: boolean; text: string };


const fill = (d: Draft | null, saved: string): Draft => (d === null || d.text === d.from ? { from: saved, text: saved } : { from: saved, text: d.text });

export function Instructions({ route }: { route: SettingsRoute }) {
  const live = useLive();
  const projects = useProjects();
  const [project, setProject] = useState<Scope | null>(() => (route.for ? parseScope(route.for) : null));
  const [pending, setPending] = useState<Scope | null>(null);
  const ref = project ? projectRefOf(project) : undefined;
  const key = project ? scopeKey(project) : "hub";

  const [load, reload] = useRead("prompt_get", { id: INSTRUCTIONS, ...(ref ? { projectRef: ref } : {}) }, live);
  const hubCall = useHubCall();
  const refetch = useRefetch();

  const [global, setGlobal] = useState<Draft | null>(null);
  const [own, setOwn] = useState<{ key: string; draft: Draft } | null>(null);
  const [synced, setSynced] = useState<PromptDetail | null>(null);
  const [busy, setBusy] = useState<PromptScope | null>(null);
  const [echo, setEcho] = useState<Echo | null>(null);

  const d = load.state === "ready" ? load.value : null;
  if (d && d !== synced) {
    setSynced(d);
    setGlobal(fill(global, d.global?.text ?? ""));
    // Another project's text is never kept.
    setOwn({ key, draft: fill(own?.key === key ? own.draft : null, d.project?.text ?? "") });
  }

  useEffect(() => {
    replaceRoute({ tab: "instructions", for: project?.kind === "project" ? key : null });
  }, [project?.kind, key]);

  const ownDirty = own !== null && own.key === key && own.draft.text !== own.draft.from;
  // Until the hub has answered for this connection, only what you typed and haven't saved is shown; an untouched
  // text is the last connection's answer, not the hub's now, so it shows as loading and can't be edited.
  const shown = (draft: Draft | null) => shownDraft(d !== null, draft);
  const globalShown = shown(global);
  const ownShown = shown(own?.key === key ? own.draft : null);
  const pick = (next: Scope) => {
    if (scopeKey(next) === key) return;
    if (ownDirty) setPending(next);
    else {
      setProject(next);
      setEcho(null);
    }
  };

  const save = (scope: PromptScope, text: string) => {
    if (!d || busy) return;
    setBusy(scope);
    setEcho(null);
    hubCall("prompt_set", { id: INSTRUCTIONS, scope, ...(scope === "project" && ref ? { projectRef: ref } : {}), text, base: d.default.ref }).then(
      () => {
        setBusy(null);
        const whose = scope === "project" && project ? `for ${scopeName(project, projects)}` : "for every project";
        setEcho({ ok: true, text: `Saved ${whose}. New agents get them; a lead gets them at its next restart.` });
        if (scope === "global") setGlobal({ from: text, text });
        else setOwn({ key, draft: { from: text, text } });
        refetch(["prompt_get"]);
      },
      (e: unknown) => {
        setBusy(null);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  if (!live) {
    return (
      <div className={s.scroll} data-screen="settings.instructions">
        <div className={s.column}>
          <PageHead title="Instructions" />
          <Text tone="quiet">Not connected. Connect to a hub to add instructions for its agents.</Text>
        </div>
      </div>
    );
  }

  const ownDraft = ownShown;
  const name = project ? scopeName(project, projects) : null;
  return (
    <div className={s.scroll} data-screen="settings.instructions">
      <div className={s.column}>
        <PageHead title="Instructions">
          Added to every agent's first message, the lead's too: these first, then the project's own.
        </PageHead>
        {load.state === "failed" ? (
          <div className={s.inline}>
            <Text tone="danger">{load.message}</Text>
            <Button onClick={reload}>Try again</Button>
          </div>
        ) : null}
        <div className={s.stack}>
          <Field label="Every project" description="Sent to every agent on this hub.">
            <Textarea
              value={globalShown?.text ?? ""}
              disabled={d === null}
              minRows={6}
              maxRows={24}
              placeholder={d === null ? "Loading…" : "e.g. Keep pull requests under 400 changed lines."}
              onChange={(e) => setGlobal({ from: global?.from ?? "", text: e.target.value })}
            />
          </Field>
          <div className={s.actions}>
            <Button
              variant="primary"
              disabled={d === null || global === null || global.text === global.from || busy !== null}
              onClick={() => global && save("global", global.text)}
            >
              {busy === "global" ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" disabled={globalShown === null || globalShown.text === globalShown.from} onClick={() => global && setGlobal({ ...global, text: global.from })}>
              Discard changes
            </Button>
          </div>
        </div>
        <Separator />
        <div className={s.stack}>
          <div className={s.setting}>
            <div className={s.settingLabel}>
              <Text strong>One project</Text>
              <Text size="xs" tone="quiet">
                {name ? `Sent to ${name}'s agents only, after the ones above.` : "Pick a project to add instructions for it alone."}
              </Text>
            </div>
            <ScopeSelect id="instructions-for" className={s.scopeSelect} value={project} projects={projects} onChange={pick} />
          </div>
          {project ? (
            <>
              <Textarea
                aria-label={`Instructions for ${name ?? "this project"}`}
                value={ownDraft?.text ?? ""}
                disabled={d === null}
                minRows={6}
                maxRows={24}
                placeholder={d === null ? "Loading…" : "e.g. Use pnpm, not npm."}
                onChange={(e) => setOwn({ key, draft: { from: ownDraft?.from ?? "", text: e.target.value } })}
              />
              <div className={s.actions}>
                <Button variant="primary" disabled={d === null || !ownDirty || busy !== null} onClick={() => ownDraft && save("project", ownDraft.text)}>
                  {busy === "project" ? "Saving…" : "Save"}
                </Button>
                <Button variant="ghost" disabled={!ownDirty} onClick={() => ownDraft && setOwn({ key, draft: { ...ownDraft, text: ownDraft.from } })}>
                  Discard changes
                </Button>
              </div>
            </>
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
      <ConfirmDiscard
        open={pending !== null}
        what={`${name ?? "this project"}'s instructions`}
        why={pending ? `Showing ${scopeName(pending, projects)} drops them.` : ""}
        onKeep={() => setPending(null)}
        onDiscard={() => {
          if (pending) setProject(pending);
          setPending(null);
          setEcho(null);
        }}
      />
    </div>
  );
}
