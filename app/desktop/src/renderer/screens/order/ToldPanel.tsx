// "What <x> was told": what a session was sent at its start, in human words (order-view brief A).

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, IdChip, Markdown, Text, Tooltip } from "../../ui";
import type { PromptSummary, SessionPrompt, ThreadRef } from "./contracts";
import { toldView, type ToldGroup, type ToldWho } from "./told";
import s from "./order.module.css";

type Load = { readonly t: "loading" } | { readonly t: "failed"; readonly message: string } | { readonly t: "ready"; readonly prompt: SessionPrompt; readonly registry: readonly PromptSummary[] };

/** What the panel needs: the session's prompt and the registry's titles. Fixtures pass it ready. */
export type ToldSource = (thread: ThreadRef, projectRef: { machineId: string; projectId: string } | undefined) => Promise<Load>;

export const hubToldSource: ToldSource = async (thread, projectRef) => {
  const [sp, list] = await Promise.all([
    window.fleetd.hub.call("session_prompt_get", { machineId: thread.machineId, threadId: thread.threadId }),
    window.fleetd.hub.call("prompts_list", projectRef ? { projectRef } : {}),
  ]);
  if (!sp.ok) return { t: "failed", message: sp.error.message };
  const registry = list.ok ? (list.output as { prompts: readonly PromptSummary[] }).prompts : [];
  return { t: "ready", prompt: (sp.output as { session: SessionPrompt }).session, registry };
};

function Groups({ groups }: { groups: readonly ToldGroup[] }) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.group} className={s.toldGroup}>
          <Text size="xs" tone="quiet" strong>
            {g.label}
          </Text>
          {g.rows.map((r) => (
            <div key={r.id} className={s.toldRow}>
              <IdChip label={r.title} id={r.ref} kind="text" />
              <Text size="xs" tone={r.scope === "default" ? "quiet" : "default"}>
                {r.level}
              </Text>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function Body({ prompt, registry, who }: { prompt: SessionPrompt; registry: readonly PromptSummary[]; who: ToldWho }) {
  const view = toldView(prompt, registry, who);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const Chevron = defaultsOpen ? ChevronDown : ChevronRight;
  const started = new Date(prompt.startedAt).toLocaleString();
  return (
    <div className={s.told} data-screen="order.told">
      <div className={s.receipt}>
        <Text size="xs" tone="quiet">{`${view.context} · started ${started}`}</Text>
        <IdChip label="Session" id={`${prompt.machineId}/${prompt.threadId}`} kind="thread" size="xs" tone="quiet" />
        <IdChip label="Text" id={prompt.textSha} kind="text hash" size="xs" tone="quiet" />
      </div>

      <div className={s.section}>
        <span className={s.sectionLabel}>Prompts pinned at its start</span>
      </div>
      {view.overrides.length > 0 ? <Groups groups={view.overrides} /> : null}
      {view.defaultCount > 0 ? (
        <div>
          <button type="button" className={s.disclosure} aria-expanded={defaultsOpen} onClick={() => setDefaultsOpen((o) => !o)}>
            <Chevron className={s.chevron} aria-hidden />
            <Text size="xs" tone="inherit">
              {view.overrides.length === 0
                ? `All ${view.defaultCount} prompts: fleetd’s defaults`
                : `The other ${view.defaultCount} prompts: fleetd’s defaults`}
            </Text>
          </button>
          {defaultsOpen ? <Groups groups={view.defaults} /> : null}
        </div>
      ) : null}
      <Text size="xs" tone="quiet">
        Its later messages (wakes, review findings, nudges) render from these same texts. Edits reach it only when it
        starts again: a lead at its next restart, a task at its next attempt.
      </Text>

      <div className={s.section}>
        <span className={s.sectionLabel}>Tools it never gets</span>
      </div>
      {view.tools.map((t) => (
        <div key={t.label} className={s.toldTool}>
          <Tooltip content={t.names.join(", ")}>
            <span tabIndex={0}>
              <Text strong>{t.label}</Text>
            </span>
          </Tooltip>
          <Text size="xs" tone="quiet">
            {t.why}
          </Text>
        </div>
      ))}

      <div className={s.section}>
        <span className={s.sectionLabel}>First message</span>
        <Text size="xs" tone="quiet">
          Raw shows it exactly as sent.
        </Text>
      </div>
      <div className={s.toldFirst}>
        <Markdown source={prompt.text} rawToggle />
      </div>
    </div>
  );
}

/** Keyed by the thread, so opening another agent's panel starts from "loading". */
function Loader(props: { thread: ThreadRef; who: ToldWho; projectRef: { machineId: string; projectId: string } | undefined; source: ToldSource }) {
  const { source } = props;
  const { machineId, threadId } = props.thread;
  const pm = props.projectRef?.machineId;
  const pp = props.projectRef?.projectId;
  const [load, setLoad] = useState<Load>({ t: "loading" });
  // Primitive deps: the order refetches on every event, handing over equal but new objects.
  useEffect(() => {
    let live = true;
    void source({ machineId, threadId }, pm !== undefined && pp !== undefined ? { machineId: pm, projectId: pp } : undefined).then((l) => {
      if (live) setLoad(l);
    });
    return () => {
      live = false;
    };
  }, [machineId, threadId, pm, pp, source]);
  if (load.t === "loading") return <Text tone="quiet">Loading what it was sent…</Text>;
  if (load.t === "failed") return <Text tone="danger">{load.message}</Text>;
  return <Body prompt={load.prompt} registry={load.registry} who={props.who} />;
}

export function ToldPanel(props: {
  open: { thread: ThreadRef; who: ToldWho; name: string } | undefined;
  projectRef: { machineId: string; projectId: string } | undefined;
  source: ToldSource;
  onClose: () => void;
}) {
  const { open } = props;

  return (
    <Dialog
      open={open !== undefined}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      title={`What ${open?.name ?? "it"} was told`}
      wide
    >
      {open === undefined ? null : (
        <Loader key={`${open.thread.machineId}/${open.thread.threadId}`} thread={open.thread} who={open.who} projectRef={props.projectRef} source={props.source} />
      )}
    </Dialog>
  );
}
