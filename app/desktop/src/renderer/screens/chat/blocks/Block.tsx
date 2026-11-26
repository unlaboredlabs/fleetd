// One block, by kind. One that throws while drawing shows the calm error card in its place; the rest of the chat stays.
// An agent's, a PR's and a diff's cards draw from the Agents pane, the PR page and the diff view, each a screen of its
// own: they load as chunks, so the web's first chat doesn't wait on them. The desktop asks for them at once (from
// disk, in hand before a chat has drawn); the web once the chat has shown, a card's place busy until it comes.
import { Suspense } from "react";
import type { AttachmentBlock, ChatBlock } from "../../../../shared/contracts";
import { Boundary } from "../../../src/Boundary";
import { onWeb } from "../../../src/web";
import { preloadable, preloadWhenIdle } from "../../../ui";
import { Ask } from "./Ask";
import { Chart } from "./Chart";
import { FileCard } from "./FileCard";
import { Checklist, Media } from "./Media";
import { PreviewCard } from "./PreviewCard";
import { Table } from "./Table";
import { useBubbleActions } from "../actions";

const AgentCard = preloadable(() => import("./AgentCard").then((m) => m.AgentCard));
const PrCard = preloadable(() => import("./PrCard").then((m) => m.PrCard));
const Diff = preloadable(() => import("./Diff").then((m) => m.Diff));
if (onWeb()) preloadWhenIdle(AgentCard, PrCard, Diff);
else for (const card of [AgentCard, PrCard, Diff]) card.preload().catch(() => undefined);

function Body({ block, answer }: { block: ChatBlock; answer: string | undefined }) {
  switch (block.kind) {
    case "chart":
      return <Chart chart={block} />;
    case "table":
      return <Table table={block} />;
    case "diff":
      return <Diff diff={block} />;
    case "pr":
      return <PrCard pr={block} />;
    case "agent":
      return <AgentCard agent={block} />;
    case "checklist":
      return <Checklist list={block} />;
    case "image":
      return <Media media={block} clip={false} />;
    case "clip":
      return <Media media={block} clip />;
    case "file":
      return <BlockFile block={block} />;
    case "ask":
      return <Ask ask={block} answer={answer} />;
    case "preview":
      return <PreviewCard preview={block} />;
  }
}

function BlockFile({ block }: { block: AttachmentBlock }) {
  const project = useBubbleActions()?.project;
  const file = { attachmentId: block.attachmentId, name: block.name ?? "file", mime: block.mime ?? "", bytes: block.bytes };
  return <FileCard project={project} file={file} caption={block.caption} />;
}

export function Block({ block, answer }: { block: ChatBlock; answer?: string | undefined }) {
  return (
    <Boundary part="this part of the message">
      <Suspense fallback={<div aria-busy="true" />}>
        <Body block={block} answer={answer} />
      </Suspense>
    </Boundary>
  );
}
