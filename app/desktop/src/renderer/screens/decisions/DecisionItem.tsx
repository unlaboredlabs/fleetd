// One question and its answer: the value first, then who decided, where it applies and when, quietly. Opened, its
// why, what it replaced (or that you revoked it), and for one in force a way to change or revoke it, with a short why
// the lead reads at its next wake.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState, type SyntheticEvent } from "react";
import type { Decision } from "../../../shared/contracts";
import { useDataLayer } from "../../src/data/react";
import { Button, Field, StatusChip, Text, Textarea, Truncate, cx } from "../../ui";
import { fateWord, metaLine, overturnProblem, when, whoWord, type Thread } from "./model";
import s from "./decisions.module.css";

interface ItemProps {
  readonly thread: Thread;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly nowMs: number;
  /** A change or revoke went through: read the list again now, not only on the event. */
  readonly onChanged: () => void;
}

export function DecisionItem({ thread, expanded, onToggle, nowMs, onChanged }: ItemProps) {
  const { head } = thread;
  const details = useId();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <li className={cx(s.item, expanded && s.open)} data-decision={thread.live ? "live" : "revoked"}>
      <button type="button" className={s.row} aria-expanded={expanded} aria-controls={details} onClick={onToggle}>
        <Chevron className={s.chevron} aria-hidden />
        <span className={s.rowBody}>
          <span className={s.rowKey}>
            <Truncate size="xs" tone="quiet" expand="none">
              {thread.words}
            </Truncate>
          </span>
          <span className={cx(s.value, !thread.live && s.revokedValue)}>
            <Truncate lines={expanded ? 12 : 2} expand="none" tone={thread.live ? "default" : "quiet"}>
              {head.value}
            </Truncate>
          </span>
          <span className={s.rowMeta}>
            {!thread.live ? <StatusChip tone="idle" inRow>revoked</StatusChip> : null}
            <Truncate size="xs" tone="faint" expand="none">
              {metaLine(thread)}
            </Truncate>
            <span className={s.rowWhen}>
              <Text size="xs" tone="faint" tabular>
                {when(head.retired?.at ?? head.at, nowMs)}
              </Text>
            </span>
          </span>
        </span>
      </button>
      {expanded ? <Details id={details} thread={thread} nowMs={nowMs} onChanged={onChanged} /> : null}
    </li>
  );
}

function Details({ id, thread, nowMs, onChanged }: { id: string; thread: Thread; nowMs: number; onChanged: () => void }) {
  const { head } = thread;
  const [mode, setMode] = useState<"change" | "revoke" | null>(null);
  return (
    <div id={id} className={s.details}>
      {head.retired !== undefined ? (
        <Note label={`You revoked it · ${when(head.retired.at, nowMs)}`} text={head.retired.why} />
      ) : null}
      <Note label={`Why · ${whoWord(head)} · ${when(head.at, nowMs)}`} text={head.why} none="No reason was given." />
      {thread.earlier.length > 0 ? <Earlier decisions={thread.earlier} nowMs={nowMs} /> : null}
      {thread.live ? (
        mode === null ? (
          <div className={s.actions}>
            <Button size="sm" onClick={() => setMode("change")}>
              Change…
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setMode("revoke")}>
              Revoke…
            </Button>
          </div>
        ) : (
          <Overturn
            key={mode}
            decision={head}
            mode={mode}
            onCancel={() => setMode(null)}
            onDone={() => {
              setMode(null);
              onChanged();
            }}
          />
        )
      ) : null}
    </div>
  );
}

function Note({ label, text, none }: { label: string; text: string | undefined; none?: string }) {
  if (text === undefined && none === undefined) return null;
  return (
    <div className={s.note}>
      <Text size="xs" tone="quiet">
        {label}
      </Text>
      <Text size="sm" tone={text === undefined ? "faint" : "default"} preserveLines>
        {text ?? none ?? ""}
      </Text>
    </div>
  );
}

/** What this key was before, newest first. */
function Earlier({ decisions, nowMs }: { decisions: readonly Decision[]; nowMs: number }) {
  return (
    <div className={s.note}>
      <Text size="xs" tone="quiet">
        Before
      </Text>
      <ol className={s.earlier}>
        {decisions.map((d) => (
          <li key={d.decisionId} className={s.earlierItem}>
            <Text size="sm" tone="quiet" preserveLines>
              {d.value}
            </Text>
            <Text size="xs" tone="faint">
              {[whoWord(d), when(d.at, nowMs), fateWord(d)].join(" · ")}
            </Text>
            {d.why !== undefined ? (
              <Text size="xs" tone="faint" preserveLines>
                {d.why}
              </Text>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

interface OverturnProps {
  readonly decision: Decision;
  readonly mode: "change" | "revoke";
  readonly onCancel: () => void;
  readonly onDone: () => void;
}

/** Change a decision's value, or revoke it, with a why: the hub's decisions_overturn, from your device's key. */
function Overturn({ decision, mode, onCancel, onDone }: OverturnProps) {
  const layer = useDataLayer();
  const [value, setValue] = useState(mode === "change" ? decision.value : "");
  const [why, setWhy] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const problem = overturnProblem(mode, value, why, decision.value);
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem !== undefined || busy) return;
    setBusy(true);
    setFailed(null);
    const input = mode === "change" ? { decisionId: decision.decisionId, value: value.trim(), why: why.trim() } : { decisionId: decision.decisionId, why: why.trim() };
    void layer.call("decisions_overturn", input).then((out) => {
      setBusy(false);
      if (out.ok) onDone();
      else setFailed(out.error.fix ? `${out.error.message} ${out.error.fix}` : out.error.message);
    });
  };
  return (
    <form className={s.form} onSubmit={submit} aria-label={mode === "change" ? "Change this decision" : "Revoke this decision"}>
      {mode === "change" ? (
        <Field label="New value">
          <Textarea value={value} minRows={1} maxRows={6} onChange={(e) => setValue(e.currentTarget.value)} autoFocus />
        </Field>
      ) : (
        <Text size="sm" tone="quiet">
          The lead stops relying on it, and asks you again when it comes up.
        </Text>
      )}
      <Field label="Why" description="A few words; the lead reads them at its next wake." error={tried ? problem : undefined}>
        <Textarea value={why} minRows={1} maxRows={4} onChange={(e) => setWhy(e.currentTarget.value)} autoFocus={mode === "revoke"} />
      </Field>
      {failed !== null ? (
        <div role="alert">
          <Text size="xs" tone="danger">
            {failed}
          </Text>
        </div>
      ) : null}
      <div className={s.actions}>
        <Button size="sm" variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" type="submit" variant={mode === "change" ? "primary" : "danger"} disabled={busy}>
          {busy ? (mode === "change" ? "Saving…" : "Revoking…") : mode === "change" ? "Save change" : "Revoke"}
        </Button>
      </div>
    </form>
  );
}
