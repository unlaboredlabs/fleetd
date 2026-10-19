// Stand-ins for the screens the budgets measure until they exist: a 20k-line conversation log in the design
// system's VirtualList (the scroll budget) and a composer (the keypress budget, and FLEETD_DEMO_TYPE's target).
// perf/targets.ts points the harness at the real screens once they land.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Text, Textarea, UiProvider, VirtualList } from "../ui";
import { makeLog, type LogLine } from "./log";
import s from "./standin.module.css";

const LINES = 20_000;

const Row = ({ line }: { line: LogLine }) => (
  <div className={s.row}>
    <Text size={line.kind === "message" ? "md" : "sm"} tone={line.kind === "tool" ? "quiet" : "default"} mono={line.kind === "code"}>
      {line.text}
    </Text>
  </div>
);

const StandIn = () => {
  const [lines, setLines] = useState(() => makeLog(LINES));
  const [draft, setDraft] = useState("");
  return (
    <div className={s.frame} data-screen="perf-standin">
      <header className={s.topBar} />
      <div className={s.log} data-perf="log">
        <VirtualList items={lines} getKey={(l) => l.id} renderItem={(l) => <Row line={l} />} estimateSize={28} followOutput aria-label="Conversation" />
      </div>
      <div className={s.composer}>
        <Textarea
          aria-label="Order"
          data-composer="ready"
          value={draft}
          minRows={2}
          maxRows={8}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            e.preventDefault();
            if (draft.trim() === "") return;
            setLines((all) => [...all, { id: all.length, kind: "message", text: draft }]);
            setDraft("");
          }}
        />
      </div>
    </div>
  );
};

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <UiProvider>
      <StandIn />
    </UiProvider>
  </StrictMode>,
);
