// Needs you renders the inbox's own question cards (F5), with the asks from the data layer, so an answer here is the
// same one-tap answer as in the inbox and clears everywhere. An ask the layer doesn't hold open (still loading, or
// answered a moment ago) links to the inbox panel on it rather than showing a card that would answer it twice.

import { Button, Text } from "../../ui";
import { QuestionCard } from "../inbox/QuestionCard";
import { useData } from "../../src/data/react";
import s from "./status.module.css";
import { needsYouRow } from "./view";

const openAsk = (askId: string): void => {
  const route = window.location.hash.split("?")[0] ?? "#/status";
  window.location.hash = `${route}?inbox&ask=${encodeURIComponent(askId)}`;
};

export function NeedsYou({ askIds, count }: { askIds: readonly string[]; count: number }) {
  const asks = useData((s) => s.asks);
  if (count === 0) {
    return (
      <Text size="xs" tone="quiet">
        nothing needs you
      </Text>
    );
  }
  return (
    <div className={s.asks}>
      {askIds.map((id) => {
        const row = needsYouRow(asks, id);
        return row.kind === "card" ? (
          <QuestionCard key={id} ask={row.ask} />
        ) : (
          <div key={id} className={s.ask}>
            <Text>{row.kind === "changed" ? "A decision that just changed" : "A decision is waiting for you"}</Text>
            <Button variant="secondary" onClick={() => openAsk(id)}>
              Open in the inbox
            </Button>
          </div>
        );
      })}
      {count > askIds.length ? (
        <Button variant="quiet" onClick={() => (window.location.hash = "#/inbox")}>
          {`All ${count} in the inbox`}
        </Button>
      ) : null}
    </div>
  );
}
