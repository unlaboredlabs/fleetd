// Insights: the hub's deterministic findings (spec §6), strongest first, each with its numbers and a way to the
// spans behind it. The app adds nothing to the message but layout.
import { Button, InlineCode, Text, cx } from "../../ui";
import type { Linked } from "./data";
import { capitalized, compareLine, pieces } from "./insightText";
import type { Insight } from "./types";
import s from "./Time.module.css";

export interface InsightsProps {
  readonly insights: readonly Insight[];
  readonly compare: boolean;
  readonly onLinked: (linked: Linked, ids?: readonly number[]) => void;
}

function Message({ text }: { text: string }) {
  return (
    <Text as="p">
      {pieces(capitalized(text)).map((p, i) =>
        // The hub backticks machine text (commands, check names, keys): shown as code, exactly as written.
        p.code ? (
          <InlineCode key={i}>{p.text}</InlineCode>
        ) : p.mono ? (
          <Text key={i} mono size="sm">
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

const FIRED: Record<string, string | undefined> = { current: "new this period", compare: "only in the period before" };

export function Insights({ insights, compare, onLinked }: InsightsProps) {
  if (insights.length === 0) {
    return (
      <div className={cx(s.scroll)} data-screen="time.insights.empty">
        <div className={cx(s.empty)}>
          <Text strong>Nothing stands out</Text>
          <Text tone="quiet">
            None of the hub&apos;s rules fired for this period: no repeated test runs, slow checks on the critical path, long waits on you or full slots.
          </Text>
        </div>
      </div>
    );
  }
  return (
    <div className={cx(s.scroll)} data-screen="time.insights">
      <Text as="p" size="xs" tone="quiet" className={cx(s.intro)}>
        Found by fixed rules over the spans, never a model. Each one shows the numbers it fired on.
      </Text>
      <ol className={cx(s.insights)}>
        {insights.map((ins, ix) => {
          // A title is plain text: the hub's backticks only mark code inside the message.
          const linked: Linked = { title: capitalized(ins.message).replace(/`/gu, ""), rule: ins.rule };
          const n = ins.spanIds.length;
          const fired = ins.firedIn === undefined ? undefined : FIRED[ins.firedIn];
          return (
            <li key={`${ins.rule}-${ix}`} className={cx(s.insight)}>
              <Text mono size="sm" tone="quiet" className={cx(s.insightNo)}>
                {String(ix + 1)}
              </Text>
              <div className={cx(s.insightBody)}>
                <Message text={ins.message} />
                {compare && ins.compare !== undefined ? (
                  <Text as="p" size="xs" tone="quiet" mono>
                    {compareLine(ins.numbers, ins.compare)}
                  </Text>
                ) : null}
                {fired !== undefined ? (
                  <Text as="p" size="xs" tone="quiet">
                    {fired}
                  </Text>
                ) : null}
              </div>
              <Button variant="ghost" disabled={n === 0 && ins.firedIn === "compare"} onClick={() => onLinked(linked, ins.spanIds)}>
                {n === 0 ? "Show spans" : `Show ${n} span${n === 1 ? "" : "s"}`}
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
