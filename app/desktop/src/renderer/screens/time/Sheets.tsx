// The two side sheets: a span's transcript (the items around it, that one marked) and the spans a finding or a
// row links to, one per line as `fleetd time --spans` prints them.
import { Button, Sheet, Text, Truncate, VirtualList, cx, humanizeKey } from "../../ui";
import type { Answer } from "./data";
import { clockMs, inexact, laneName, markedDur, spanTitle, type Names } from "./format";
import type { Span, ThreadWindowOutput } from "./types";
import s from "./Time.module.css";

export interface TranscriptSheetProps {
  readonly open: boolean;
  readonly who: string;
  readonly answer: Answer<ThreadWindowOutput> | undefined;
  readonly onClose: () => void;
  /** Opens the project's chat; absent when the screen has no work to go from. */
  readonly onOpenInOrder: (() => void) | undefined;
}

export function TranscriptSheet({ open, who, answer, onClose, onOpenInOrder }: TranscriptSheetProps) {
  const body =
    answer === undefined ? (
      <Text tone="quiet">Asking the machine for this part of the transcript…</Text>
    ) : !answer.ok ? (
      <Text tone="danger">{answer.error}</Text>
    ) : answer.value.focus === undefined ? (
      <Text tone="quiet">The machine no longer has this item: its session was cleaned up. The span&apos;s numbers still stand.</Text>
    ) : (
      <ol className={cx(s.transcript)}>
        {answer.value.items.map((it, ix) => {
          const focused = ix === answer.value.focus;
          return (
            <li key={`${it.at}-${ix}`} className={cx(s.trItem, focused && s.trFocus)} aria-current={focused ? "true" : undefined}>
              <Text size="xs" mono tone="quiet" className={cx(s.trAt)}>
                {clockMs(Date.parse(it.at))}
              </Text>
              <div className={cx(s.trBody)}>
                {it.kind === "message" ? (
                  <>
                    <Text size="xs" tone="quiet">
                      {it.role === "user" ? "you" : it.role === "assistant" ? "agent" : "system"}
                    </Text>
                    <Text as="p" preserveLines>
                      {it.text}
                    </Text>
                  </>
                ) : (
                  <>
                    <div className={cx(s.trAction)}>
                      <Text mono size="sm">
                        {it.action.summary}
                      </Text>
                      {it.action.exitCode !== undefined ? (
                        <Text size="xs" tone={it.action.failed ? "danger" : "quiet"} className={cx(s.noShrink)}>
                          exit {it.action.exitCode}
                        </Text>
                      ) : null}
                    </div>
                    {focused && it.action.outputTail !== undefined ? (
                      <Text as="pre" mono size="sm" tone="quiet" preserveLines className={cx(s.trTail)}>
                        {it.action.outputTail}
                      </Text>
                    ) : null}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    );
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Transcript"
      description={`${who}: what the agent said and ran around the span you clicked, which is marked.`}
      footer={
        onOpenInOrder !== undefined ? (
          <Button variant="secondary" onClick={onOpenInOrder}>
            Open the chat
          </Button>
        ) : undefined
      }
    >
      {body}
    </Sheet>
  );
}

export interface LinkedSheetProps {
  readonly title: string | undefined;
  readonly answer: Answer<Span[]> | undefined;
  readonly names: Names;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onSpan: (span: Span) => void;
}

export function LinkedSheet({ title, answer, names, nowMs, onClose, onSpan }: LinkedSheetProps) {
  const spans = answer?.ok === true ? answer.value : [];
  // A list over days needs the day beside each time; within one day the clock alone reads faster.
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const days = spans.length > 0 && day(spans[0]?.startMs ?? 0) !== day(spans.at(-1)?.startMs ?? 0);
  const when = (ms: number) => (days ? new Date(ms).toISOString().slice(5, 16).replace("T", " ") : clockMs(ms));
  return (
    <Sheet open={title !== undefined} onOpenChange={(o) => !o && onClose()} title={title ?? ""}>
      {answer === undefined ? (
        <Text tone="quiet">Asking the hub for these spans…</Text>
      ) : !answer.ok ? (
        <Text tone="danger">{answer.error}</Text>
      ) : spans.length === 0 ? (
        <Text tone="quiet">No spans in this period.</Text>
      ) : (
        <div className={cx(s.linked)}>
          <Text size="xs" tone="quiet">
            {spans.length} span{spans.length === 1 ? "" : "s"}
            {spans.length >= 500 ? " (the first 500)" : ""}
          </Text>
          <div className={cx(s.linkedList)}>
            <VirtualList
              items={spans}
              getKey={(x) => x.id}
              estimateSize={28}
              renderItem={(x) => {
                const mark = inexact(x, names, false)?.mark;
                const clickable = x.extra?.url !== undefined || (x.itemId !== undefined && x.threadId !== undefined);
                return (
                  <button type="button" className={cx(s.linkedRow, days && s.linkedRowDays)} disabled={!clickable} onClick={() => onSpan(x)}>
                    <Text size="xs" mono tone="quiet" tabular>
                      {when(x.startMs)}
                    </Text>
                    <Text size="xs" mono tabular>
                      {markedDur((x.endMs ?? nowMs) - x.startMs, mark)}
                    </Text>
                    <Text size="xs" tone={x.status === "failed" ? "danger" : "quiet"}>
                      {x.exitCode !== undefined ? `exit ${x.exitCode}` : ""}
                    </Text>
                    <Truncate expand="none" size="xs" tone="quiet">
                      {laneName(names, x)}
                    </Truncate>
                    <Truncate expand="none" size="sm" mono>
                      {spanTitle(x, humanizeKey)}
                    </Truncate>
                  </button>
                );
              }}
            />
          </div>
        </div>
      )}
    </Sheet>
  );
}
