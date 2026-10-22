// "What <x> was told": what a session was sent at its start, in human words (order-view brief A).

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { Button, Code, Dialog, IdChip, Text, Tooltip } from "../../ui";
import { Message } from "./text";
import type { PromptSummary, SessionPrompt, ThreadRef } from "../../../shared/contracts";
import { toldView, type ToldGroup, type ToldWho } from "./told";
import s from "./view.module.css";

const noPrompts: readonly PromptSummary[] = [];

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
  const [raw, setRaw] = useState(false);
  const Chevron = defaultsOpen ? ChevronDown : ChevronRight;
  // An unparseable time would read "Invalid Date"; leave it out instead.
  const startedMs = Date.parse(prompt.startedAt);
  const started = Number.isNaN(startedMs) ? "" : ` · started ${new Date(startedMs).toLocaleString()}`;
  return (
    <div className={s.told} data-screen="order.told">
      <div className={s.receipt}>
        <Text size="xs" tone="quiet">{`${view.context}${started}`}</Text>
        <IdChip label="Session id" id={`${prompt.machineId}/${prompt.threadId}`} kind="thread" size="xs" tone="quiet" />
        <IdChip label="Text version" id={prompt.textSha} kind="text hash" size="xs" tone="quiet" />
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
          {raw ? "Exactly as sent." : "Raw shows it exactly as sent."}
        </Text>
        <Button variant="quiet" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
          {raw ? "Formatted" : "Raw"}
        </Button>
      </div>
      <div className={s.toldFirst}>{raw ? <Code code={prompt.text} lang="markdown" title="First message" /> : <Message text={prompt.text} />}</div>
    </div>
  );
}

function Loader(props: { thread: ThreadRef; who: ToldWho; projectRef: { machineId: string; projectId: string } | undefined }) {
  const { machineId, threadId } = props.thread;
  const prompt = useToolQuery("session_prompt_get", { machineId, threadId });
  // The registry's titles; without them the ids still read as words.
  const registry = useToolQuery("prompts_list", props.projectRef ? { projectRef: props.projectRef } : {});
  if (prompt.error instanceof CallError)
    return (
      <div className={s.errorRow}>
        <Text tone="quiet">Couldn’t load what it was sent.</Text>
        <IdChip label="Details" id={prompt.error.error.message} kind="error" size="xs" tone="quiet" />
      </div>
    );
  if (prompt.data === undefined || (registry.data === undefined && !registry.isError)) return <Text tone="quiet">Loading what it was sent…</Text>;
  return <Body prompt={prompt.data.session} registry={registry.data?.prompts ?? noPrompts} who={props.who} />;
}

export function ToldPanel(props: {
  open: { thread: ThreadRef; who: ToldWho; name: string } | undefined;
  projectRef: { machineId: string; projectId: string } | undefined;
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
        <Loader key={`${open.thread.machineId}/${open.thread.threadId}`} thread={open.thread} who={open.who} projectRef={props.projectRef} />
      )}
    </Dialog>
  );
}
