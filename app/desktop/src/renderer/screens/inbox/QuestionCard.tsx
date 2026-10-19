// The one question card. The board's Needs you, the inbox panel, the order view and Status all render this, so an
// answer given anywhere reads the same and clears everywhere (one store).
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button, cx, IdChip, RadioCard, RadioGroup, Text, Textarea, Truncate } from "../../ui";
import { cardOptions, classTag, takesFreeText, takesSkip, type CardPick } from "./ask";
import type { Ask, GatedRunSpec } from "./contracts";
import { askPlace, type Answered } from "./model";
import { inboxStore, useInbox } from "./store";
import s from "./QuestionCard.module.css";

/** The radio value of "Something else…"; option keys are slugs, so it can't collide. */
const OTHER = " other";

export interface QuestionCardViewProps {
  ask: Ask;
  place: { readonly project: string; readonly order: string | null };
  answered?: Answered | undefined;
  error?: string | undefined;
  /** False while the hub is unreachable: nothing can be sent. */
  live: boolean;
  /** Focus the card on mount, so 1–9 and Enter reach it (the inbox panel's first or linked ask). */
  autoFocus?: boolean | undefined;
  onAnswer: (pick: CardPick) => void;
  onUndo: () => void;
  onDismiss: () => void;
}

/** A card wired to the inbox store. */
export function QuestionCard({ ask, autoFocus }: { ask: Ask; autoFocus?: boolean }) {
  const inbox = useInbox();
  const store = inboxStore();
  return (
    <QuestionCardView
      ask={ask}
      place={askPlace(inbox, ask)}
      answered={inbox.answered.get(ask.askId)}
      error={inbox.errors.get(ask.askId)}
      live={inbox.live}
      autoFocus={autoFocus}
      onAnswer={(pick) => store.answer(ask, pick)}
      onUndo={() => store.undo(ask.askId)}
      onDismiss={() => store.dismiss(ask.askId)}
    />
  );
}

export function QuestionCardView(props: QuestionCardViewProps) {
  const { ask, answered } = props;
  const titleId = useId();
  return (
    <section
      className={s.card}
      aria-labelledby={titleId}
      data-ask={ask.askId}
      data-state={answered === undefined ? "open" : "answered"}
    >
      <Header ask={ask} place={props.place} />
      {answered === undefined ? (
        <OpenBody {...props} titleId={titleId} />
      ) : (
        <AnsweredBody answered={answered} error={props.error} titleId={titleId} onUndo={props.onUndo} onDismiss={props.onDismiss} />
      )}
    </section>
  );
}

function Header({ ask, place }: { ask: Ask; place: QuestionCardViewProps["place"] }) {
  const tag = classTag(ask);
  return (
    <header className={s.header}>
      <div className={s.place}>
        {ask.number === undefined ? null : (
          <Text size="xs" tone="faint" tabular className={cx(s.number)} title={`Reply to it as ${ask.number} in the reply field`}>
            {ask.number}
          </Text>
        )}
        <Truncate size="xs" tone="quiet" strong>
          {place.project}
        </Truncate>
        {place.order !== null && ask.workstreamId !== undefined ? (
          <>
            <span className={s.dot} aria-hidden>
              ·
            </span>
            <IdChip label={place.order} id={ask.workstreamId} kind="order" size="xs" tone="quiet" />
          </>
        ) : null}
        {tag === null ? null : (
          <span className={s.tag} data-tone={ask.class === "credential" ? "warning" : "danger"}>
            {tag}
          </span>
        )}
      </div>
      {ask.blocks === "nothing" ? null : (
        <Text as="p" size="sm" tone="warning" className={cx(s.blocks)}>
          <span className={s.blocksLabel}>Blocks</span> {ask.blocks}
        </Text>
      )}
    </header>
  );
}

function OpenBody(props: QuestionCardViewProps & { titleId: string }) {
  const { ask, live, onAnswer } = props;
  const options = cardOptions(ask);
  const freeText = takesFreeText(ask);
  const skip = takesSkip(ask);
  const [picked, setPicked] = useState<string>("");
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const values = [...options.map((o) => o.id), ...(freeText ? [OTHER] : [])];

  useEffect(() => {
    if (props.autoFocus === true) rootRef.current?.focus();
  }, [props.autoFocus]);

  useEffect(() => {
    if (picked === OTHER) textRef.current?.focus();
  }, [picked]);

  const pick = (): CardPick | null => {
    if (picked === OTHER) return text.trim() === "" ? null : { type: "text", text };
    return options.find((o) => o.id === picked)?.pick ?? null;
  };
  const ready = live && pick() !== null;
  const send = (): void => {
    const p = pick();
    if (live && p !== null) onAnswer(p);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape" && text === "") {
        e.preventDefault();
        rootRef.current?.focus();
      }
      return;
    }
    // The palette's picker keys (pickerKey): 1–9 pick, Enter confirms (or, with nothing picked, moves to the
    // recommendation), N picks the No answer. A focused button acts on Enter itself; radio items don't.
    if (target instanceof HTMLButtonElement && target.getAttribute("role") !== "radio") return;
    if (e.shiftKey) return;
    const digit = /^(?:Digit|Numpad)([1-9])$/u.exec(e.code)?.[1] ?? (/^[1-9]$/u.test(e.key) ? e.key : undefined);
    let value: string | undefined;
    if (digit !== undefined) value = values[Number(digit) - 1];
    else if (e.key.toLowerCase() === "n") value = options.find((o) => o.id === "no")?.id;
    else if (e.key === "Enter") {
      e.preventDefault();
      if (picked !== "") send();
      else value = options.find((o) => o.recommended)?.id;
    }
    if (value === undefined) return;
    e.preventDefault();
    setPicked(value);
    if (value !== OTHER) rootRef.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`)?.focus();
  };

  return (
    <div ref={rootRef} className={s.body} tabIndex={-1} onKeyDown={onKeyDown}>
      <Text as="h3" id={props.titleId} strong className={cx(s.question)}>
        {ask.text}
      </Text>
      {ask.context === undefined ? null : (
        <Text as="p" tone="quiet" className={cx(s.context)}>
          {ask.context}
        </Text>
      )}
      {ask.proceededOnRec ? (
        <Text as="p" size="sm" tone="quiet">
          The lead went ahead with its recommendation; your answer confirms or changes it.
        </Text>
      ) : null}
      <Details ask={ask} />
      <RadioGroup aria-labelledby={props.titleId} value={picked} onValueChange={setPicked} className={s.options}>
        {options.map((o, i) => (
          <RadioCard
            key={o.id}
            value={o.id}
            data-value={o.id}
            label={o.label}
            {...(o.detail === undefined ? {} : { detail: o.detail })}
            {...(o.recommended ? { tag: "Recommended" } : {})}
            {...(o.reason === undefined ? {} : { reason: `Why: ${o.reason}` })}
            {...(i < 9 ? { shortcut: String(i + 1) } : {})}
            disabled={!live}
          />
        ))}
        {freeText ? (
          <RadioCard
            value={OTHER}
            data-value={OTHER}
            label="Something else…"
            detail="Write your own answer; the lead takes it as given."
            {...(options.length < 9 ? { shortcut: String(options.length + 1) } : {})}
            disabled={!live}
          />
        ) : null}
      </RadioGroup>
      {picked === OTHER ? (
        <Textarea
          ref={textRef}
          aria-label="Your answer"
          placeholder="Your answer. Enter sends, Shift+Enter starts a new line."
          value={text}
          maxLength={2000}
          minRows={2}
          maxRows={8}
          onChange={(e) => setText(e.target.value)}
        />
      ) : null}
      <div className={s.actions}>
        <Button variant={ask.class === "irreversible" ? "danger" : "primary"} disabled={!ready} shortcut="↵" onClick={send}>
          Send answer
        </Button>
        {skip ? (
          <Button variant="ghost" disabled={!live} onClick={() => onAnswer({ type: "skip" })}>
            Skip for now
          </Button>
        ) : null}
        {skip ? (
          <Text size="xs" tone="quiet" className={cx(s.skipNote)}>
            Skipping leaves the lead on its recommendation.
          </Text>
        ) : null}
      </div>
      {live ? null : (
        <Text as="p" size="sm" tone="quiet">
          Not connected to the hub. Answers can be sent once it is back.
        </Text>
      )}
      {props.error === undefined ? null : (
        <p role="alert" className={s.alert}>
          <Text size="sm" tone="danger">{props.error}</Text>
        </p>
      )}
    </div>
  );
}

/** What an approval runs, a checklist's steps, a secret's destination, and the hub's evidence. */
function Details({ ask }: { ask: Ask }) {
  return (
    <>
      {ask.gated === undefined ? null : <GatedCommand gated={ask.gated} />}
      {ask.permission === undefined ? null : (
        <div className={s.detail}>
          <Text size="xs" tone="quiet">
            {ask.permission.toolName}
          </Text>
          <Text mono size="sm" className={cx(s.command)}>
            {ask.permission.summary}
          </Text>
        </div>
      )}
      {ask.steps === undefined || ask.steps.length === 0 ? null : (
        <ol className={s.steps}>
          {ask.steps.map((step, i) => (
            <li key={i} className={s.step}>
              <Text>{step.text}</Text>
              <Text size="xs" tone="quiet">
                {step.where === "browser" ? "In a browser" : `On ${step.where}`}
              </Text>
              {step.command === undefined ? null : (
                <Text mono size="sm" className={cx(s.command)}>
                  {step.command}
                </Text>
              )}
              {step.expect === undefined ? null : (
                <Text size="sm" tone="quiet">
                  Expect: {step.expect}
                </Text>
              )}
            </li>
          ))}
        </ol>
      )}
      {ask.kind === "secret" ? (
        <Text as="p" size="sm" tone="quiet">
          {`The lead needs a secret${ask.sink === undefined ? "" : ` for ${ask.sink}`}. Entering secrets isn't in this app yet; decline it here or send it from the terminal.`}
        </Text>
      ) : null}
      {ask.evidence === undefined ? null : (
        <Text as="p" size="sm" tone="quiet" preserveLines>
          {ask.evidence}
        </Text>
      )}
    </>
  );
}

/** argv as one line a person can read, quoting only the arguments that need it. */
const shellLine = (argv: readonly string[]): string =>
  argv.map((a) => (/^[\w@%+=:,./-]+$/u.test(a) ? a : `'${a.replace(/'/gu, `'\\''`)}'`)).join(" ");

function GatedCommand({ gated }: { gated: GatedRunSpec }) {
  const minutes = Math.ceil(gated.timeoutSec / 60);
  return (
    <div className={s.detail}>
      <Text mono size="sm" className={cx(s.command)}>
        {shellLine(gated.argv)}
      </Text>
      <Text size="xs" tone="quiet">
        {`${gated.reason} · in ${gated.cwd ?? "the project folder"} · stops after ${minutes} min`}
      </Text>
    </div>
  );
}

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** Re-renders each second until `until` (epoch ms) has passed, then stops; no timer runs otherwise. */
const useCountdown = (until: number | null): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null || until <= Date.now()) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
};

function AnsweredBody(props: {
  answered: Answered;
  error: string | undefined;
  titleId: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { answered } = props;
  const left = useCountdown(answered.undoBy);
  let status: string;
  if (answered.sending) status = "Sending…";
  else if (left > 0) status = `You can undo this for ${left} s.`;
  else if (answered.deliveredAt === null) status = "Passing it to the lead…";
  else status = `The lead has your answer · ${clock(answered.deliveredAt)}`;
  return (
    <div className={s.body}>
      <Text as="p" id={props.titleId} className={cx(s.question)}>
        <Text tone="quiet">You chose: </Text>
        <Text strong>{answered.label}</Text>
      </Text>
      <Text as="p" size="xs" tone="quiet" className={cx(s.question)}>
        {answered.ask.text}
      </Text>
      <div className={s.actions}>
        <span aria-live="polite">
          <Text size="sm" tone={answered.deliveredAt === null ? "quiet" : "success"} tabular>
            {status}
          </Text>
        </span>
        {left > 0 ? (
          <Button variant="secondary" onClick={props.onUndo}>
            Undo
          </Button>
        ) : null}
        {answered.deliveredAt !== null ? (
          <Button variant="quiet" onClick={props.onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
      {props.error === undefined ? null : (
        <p role="alert" className={s.alert}>
          <Text size="sm" tone="danger">{props.error}</Text>
        </p>
      )}
    </div>
  );
}
