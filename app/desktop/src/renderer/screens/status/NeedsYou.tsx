// Needs you renders the inbox's own question cards (F5, screens/inbox/QuestionCard), so an answer here is the same
// one-tap answer as in the inbox. Until that card is on this branch's base, each ask opens the inbox panel on it
// (route `?inbox&ask=<id>`), which is where the card lives: the one swap point is this file.

import { Button, Text } from "../../ui";
import s from "./status.module.css";

const openAsk = (askId: string): void => {
  const route = window.location.hash.split("?")[0] ?? "#/status";
  window.location.hash = `${route}?inbox&ask=${encodeURIComponent(askId)}`;
};

export function NeedsYou({ askIds, count, live }: { askIds: readonly string[]; count: number; live: boolean }) {
  if (count === 0) {
    return (
      <Text size="xs" tone="quiet">
        nothing needs you
      </Text>
    );
  }
  return (
    <div className={s.asks}>
      {askIds.map((id, i) => (
        <div key={id} className={s.ask}>
          <Text strong>{i === 0 ? "A decision is waiting for you" : "Another decision is waiting"}</Text>
          {/* Answers go through the hub; with the link down they'd only fail, so the button waits for it. */}
          <Button variant={i === 0 ? "primary" : "secondary"} disabled={!live} onClick={() => openAsk(id)}>
            Answer
          </Button>
        </div>
      ))}
      {count > askIds.length ? (
        <Button variant="quiet" onClick={() => (window.location.hash = "#/inbox")}>
          {`All ${count} in the inbox`}
        </Button>
      ) : null}
    </div>
  );
}
