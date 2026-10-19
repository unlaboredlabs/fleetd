// The one question card. The board's Needs you, the inbox panel, the order view and Status all render this, so an
// answer given anywhere reads the same and clears everywhere. Hub data comes from E1's data layer; the only state
// kept here is what the person did (store.ts).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, Code, cx, IdChip, InlineCode, Input, RadioCard, RadioGroup, Text, Textarea } from "../../ui";
import { cardKey, cardOptions, classTag, secretEnvLines, takesFreeText, takesSkip, type CardPick } from "./ask";
import type { Ask, GatedRunSpec, Machine } from "../../../shared/contracts";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { prose } from "./prose";
import { askPlace, deliveredAt, secretTarget, type Answered, type SecretTarget } from "./model";
import { inboxUi, useInboxUi } from "./store";
import s from "./QuestionCard.module.css";

/** The radio value of "Something else…"; option keys are slugs, so it can't collide. */
const OTHER = " other";

export interface QuestionCardViewProps {
  ask: Ask;
  /** Secret asks: where the value goes, or why it can't be sent now. */
  secret?: SecretTarget | undefined;
  onSecret?: ((field: HTMLInputElement) => void) | undefined;
  place: { readonly project: string; readonly order: string | null };
  answered?: Answered | undefined;
  /** The receipt is well overdue: the card says the lead hasn't picked the answer up yet. */
  slow?: boolean | undefined;
  error?: string | undefined;
  /** False while the hub is unreachable: nothing can be sent. */
  live: boolean;
  /** Focus the card on mount, so 1–9 and Enter reach it (the inbox panel's first or linked ask). */
  autoFocus?: boolean | undefined;
  onAnswer: (pick: CardPick) => void;
  onUndo: () => void;
  onDismiss: () => void;
}

/** The hub is reachable and the data layer holds this connection's state, so an answer can go out. */
export const useLive = (): boolean => useData((d) => d.fresh && d.hub.phase === "live");

/** Machines with the live feed's status, which is newer than the snapshot's. */
const useMachines = (): Readonly<Record<string, Machine>> => {
  const machines = useData((d) => d.machines);
  const live = useData((d) => d.live.machines);
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(machines).map(([id, m]) => {
          const status = live[id]?.status;
          return [id, status === undefined ? m : { ...m, status }];
        }),
      ),
    [machines, live],
  );
};

/** True once `at` (epoch ms) has passed; one timer, none when `at` is null. */
const useAfter = (at: number | null): boolean => {
  const [passed, setPassed] = useState<number | null>(null);
  useEffect(() => {
    if (at === null) return;
    const id = window.setTimeout(() => setPassed(at), Math.max(0, at - Date.now()));
    return () => window.clearTimeout(id);
  }, [at]);
  return at !== null && passed === at;
};

/** How long after the undo window an answer may wait for its receipt event before the card reads the ask itself. */
const RECEIPT_GRACE_MS = 5_000;
/** After this, the card says the lead hasn't picked it up yet, instead of a "passing it on" that never ends. */
const RECEIPT_SLOW_MS = 30_000;

/**
 * When the lead got an answer given here: `ask.delivered` among the layer's events, or, if that event was missed (a
 * reconnect in between), the stored answer's `deliveredAt`, read once the undo window is a few seconds past. The
 * read is a layer query, so a later ask event or a resync reads it again.
 */
const useReceipt = (ask: Ask, local: Answered | undefined): { at: string | undefined; slow: boolean } => {
  const fromEvent = useData((d) => deliveredAt(d.events, ask.askId));
  const waiting = local !== undefined && !local.undone && local.deliveredAt === null && local.undoBy !== null && fromEvent === undefined;
  const overdue = useAfter(waiting ? local.undoBy + RECEIPT_GRACE_MS : null);
  const slow = useAfter(waiting ? local.undoBy + RECEIPT_SLOW_MS : null);
  const read = useToolQuery("asks_list", ask.batchId === undefined ? ANSWERED : { state: "answered", batchId: ask.batchId }, {
    enabled: waiting && overdue,
  });
  const fromRead = read.data?.asks.find((a) => a.askId === ask.askId)?.answer?.deliveredAt;
  const at = fromEvent ?? fromRead;
  return { at, slow: waiting && slow && at === undefined };
};

const ANSWERED = { state: "answered" } as const;

/** A card wired to the data layer (hub data) and the inbox UI state (what the person did). */
export function QuestionCard({ ask, autoFocus }: { ask: Ask; autoFocus?: boolean }) {
  const ui = useInboxUi();
  const actions = inboxUi();
  const { call } = useDataLayer();
  const live = useLive();
  const projects = useData((d) => d.projects);
  const orders = useData((d) => d.orders);
  const machines = useMachines();
  const local = ui.answered.get(ask.askId);
  const delivered = useReceipt(ask, local);
  const answered = local === undefined || local.deliveredAt !== null || delivered.at === undefined ? local : { ...local, undoBy: null, deliveredAt: delivered.at };
  const target = ask.kind === "secret" ? secretTarget(machines, ask) : undefined;
  const dismiss = useCallback(() => actions.dismiss(ask.askId), [actions, ask.askId]);
  return (
    <QuestionCardView
      ask={ask}
      place={askPlace({ projects, orders }, ask)}
      secret={target}
      onSecret={(field) => {
        if (target !== undefined) actions.submitSecret(ask, target, field);
      }}
      answered={answered}
      slow={delivered.slow}
      error={ui.errors.get(ask.askId)}
      live={live}
      autoFocus={autoFocus}
      onAnswer={(pick) => actions.answer(call, ask, pick)}
      onUndo={() => actions.undo(call, ask.askId)}
      onDismiss={dismiss}
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
        <AnsweredBody
          answered={answered}
          slow={props.slow === true}
          error={props.error}
          titleId={titleId}
          onUndo={props.onUndo}
          onDismiss={props.onDismiss}
        />
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
          <Text size="xs" tone="quiet" tabular className={cx(s.number)} title={`Reply to it as ${ask.number} in the reply field`}>
            {ask.number}
          </Text>
        )}
        {/* The project is short and always whole (it wraps); the order title takes what is left and truncates. */}
        {/* The "·" ends the project rather than starting the order, so a wrapped order title never opens with it. */}
        <Text size="xs" tone="quiet" strong className={cx(s.project, place.order !== null && ask.workstreamId !== undefined && s.beforeOrder)}>
          {place.project}
        </Text>
        {place.order !== null && ask.workstreamId !== undefined ? (
          <span className={s.order}>
            <IdChip label={place.order} id={ask.workstreamId} kind="order" size="xs" tone="quiet" />
          </span>
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
    if (props.autoFocus === true) rootRef.current?.focus({ preventScroll: true });
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
    const target = e.target as HTMLElement;
    const key = cardKey(
      { key: e.key, code: e.code, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing },
      {
        inField: target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null,
        onButton: target instanceof HTMLButtonElement && target.getAttribute("role") !== "radio",
      },
    );
    if (key === undefined) return;
    let value: string | undefined;
    if (key.kind === "pick") value = values[key.n - 1];
    else if (key.kind === "no") value = options.find((o) => o.id === "no")?.id;
    else if (picked !== "") {
      e.preventDefault();
      send();
      return;
    } else value = options.find((o) => o.recommended)?.id;
    if (value === undefined) return;
    e.preventDefault();
    setPicked(value);
    if (value !== OTHER) rootRef.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`)?.focus();
  };

  // The free-text field's own keys: Enter sends, Shift+Enter is a new line, Escape (when empty) leaves it.
  const onTextKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && text === "") {
      e.preventDefault();
      rootRef.current?.focus();
    }
  };

  return (
    <div ref={rootRef} className={s.body} tabIndex={-1} onKeyDown={onKeyDown}>
      <Text as="h3" id={props.titleId} strong className={cx(s.question)}>
        {prose(ask.text)}
      </Text>
      {ask.context === undefined ? null : (
        <Text as="p" tone="quiet" className={cx(s.context)}>
          {prose(ask.context)}
        </Text>
      )}
      {ask.proceededOnRec ? (
        <Text as="p" size="sm" tone="quiet">
          The lead went ahead with its recommendation; your answer confirms or changes it.
        </Text>
      ) : null}
      <Details ask={ask} />
      {props.secret === undefined ? null : <SecretEntry target={props.secret} live={live} onSecret={props.onSecret} />}
      <RadioGroup aria-labelledby={props.titleId} value={picked} onValueChange={setPicked} className={s.options}>
        {options.map((o, i) => (
          <RadioCard
            key={o.id}
            value={o.id}
            data-value={o.id}
            label={prose(o.label)}
            {...(o.detail === undefined ? {} : { detail: prose(o.detail) })}
            {...(o.recommended ? { tag: "Recommended" } : {})}
            {...(o.reason === undefined ? {} : { reason: prose(`Why: ${o.reason}`) })}
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
          onKeyDown={onTextKeyDown}
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
          <Code code={ask.permission.summary} bare />
        </div>
      )}
      {ask.steps === undefined || ask.steps.length === 0 ? null : (
        <ol className={s.steps}>
          {ask.steps.map((step, i) => (
            <li key={i} className={s.step}>
              <Text>{prose(step.text)}</Text>
              <Text size="xs" tone="quiet">
                {step.where === "browser" ? "In a browser" : `On ${step.where}`}
              </Text>
              {step.command === undefined ? null : (
                <Code code={step.command} lang="sh" bare />
              )}
              {step.expect === undefined ? null : (
                <Text size="sm" tone="quiet">
                  Expect: {prose(step.expect)}
                </Text>
              )}
            </li>
          ))}
        </ol>
      )}
      {ask.evidence === undefined ? null : (
        <Text as="p" size="sm" tone="quiet" preserveLines>
          {prose(ask.evidence)}
        </Text>
      )}
    </>
  );
}

/**
 * A password field whose value React never copies: it is read once on send, handed to main to seal, and the field
 * is emptied in the same step (store.submitSecret).
 */
function SecretEntry(props: { target: SecretTarget; live: boolean; onSecret: ((field: HTMLInputElement) => void) | undefined }) {
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(false);
  const { target } = props;
  if (!target.ok) {
    return (
      <p role="alert" className={s.alert}>
        <Text size="sm" tone="warning">{`${target.message} ${target.fix}`}</Text>
      </p>
    );
  }
  const send = (): void => {
    if (field.current !== null && props.live) props.onSecret?.(field.current);
    setTyped(false);
  };
  return (
    <div className={s.detail}>
      <Text size="sm">{`The value is saved ${target.where}.`}</Text>
      <div className={s.secretRow}>
        <Input
          ref={field}
          type="password"
          aria-label="Secret value"
          placeholder="Paste or type the value"
          autoComplete="off"
          className={cx(s.secretInput)}
          disabled={!props.live}
          onChange={(e) => setTyped(e.target.value !== "")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              send();
            }
          }}
        />
        <Button variant="primary" disabled={!typed || !props.live} onClick={send}>
          Seal and send
        </Button>
      </div>
      <Text size="xs" tone="quiet">
        {`It is sealed on this computer to ${target.machine}'s key. The hub only passes it on, and fleetd never shows it again.`}
      </Text>
    </div>
  );
}

/** argv as one line a person can read, quoting only the arguments that need it. */
const shellLine = (argv: readonly string[]): string =>
  argv.map((a) => (/^[\w@%+=:,./-]+$/u.test(a) ? a : `'${a.replace(/'/gu, `'\\''`)}'`)).join(" ");

function GatedCommand({ gated }: { gated: GatedRunSpec }) {
  const minutes = Math.ceil(gated.timeoutSec / 60);
  return (
    <div className={s.detail}>
      <Code code={shellLine(gated.argv)} lang="sh" bare />
      <Text size="xs" tone="quiet">
        {prose(gated.reason)} · in {gated.cwd === undefined ? "the project folder" : <InlineCode>{gated.cwd}</InlineCode>} · stops
        after {minutes} min
      </Text>
      {secretEnvLines(gated).map((line) => (
        <Text key={line} size="xs" tone="quiet">
          {prose(line)}
        </Text>
      ))}
    </div>
  );
}

const RECEIPT_MS = 30_000;

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
  slow: boolean;
  error: string | undefined;
  titleId: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { answered } = props;
  const left = useCountdown(answered.undoBy);
  const { onDismiss } = props;
  // A receipt stays half a minute, then the card goes; Dismiss takes it away sooner.
  useEffect(() => {
    if (answered.deliveredAt === null) return;
    const id = window.setTimeout(onDismiss, RECEIPT_MS);
    return () => window.clearTimeout(id);
  }, [answered.deliveredAt, onDismiss]);
  let status: string;
  if (answered.undone) status = "Taking it back…";
  else if (answered.sending) status = "Sending…";
  else if (left > 0) status = `You can undo this for ${left} s.`;
  else if (answered.deliveredAt === null && props.slow) status = "The lead hasn't picked it up yet; it gets your answer when it next wakes.";
  else if (answered.deliveredAt === null) status = "Passing it to the lead…";
  else if (answered.ask.kind === "secret") {
    status =
      answered.fingerprint === undefined
        ? `Stored · ${clock(answered.deliveredAt)}`
        : `Stored · ${clock(answered.deliveredAt)} · fingerprint \`${answered.fingerprint}\``;
  } else status = `The lead has your answer · ${clock(answered.deliveredAt)}`;
  return (
    <div className={s.body}>
      <Text as="p" id={props.titleId} className={cx(s.question)}>
        <Text tone="quiet">You chose: </Text>
        <Text strong>{answered.label}</Text>
      </Text>
      <Text as="p" size="xs" tone="quiet" className={cx(s.question)}>
        {prose(answered.ask.text)}
      </Text>
      <div className={s.actions}>
        <span aria-live="polite">
          <Text size="sm" tone={answered.deliveredAt === null ? "quiet" : "success"} tabular>
            {prose(status)}
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
