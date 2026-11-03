// One block, by kind. One that throws while drawing shows the calm error card in its place; the rest of the chat stays.
import type { AttachmentBlock, ChatBlock } from "../../../../shared/contracts";
import { Boundary } from "../../../src/Boundary";
import { AgentCard } from "./AgentCard";
import { Ask } from "./Ask";
import { Chart } from "./Chart";
import { Diff } from "./Diff";
import { FileCard } from "./FileCard";
import { Checklist, Media } from "./Media";
import { PrCard } from "./PrCard";
import { Table } from "./Table";
import { useBubbleActions } from "../actions";

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
      <Body block={block} answer={answer} />
    </Boundary>
  );
}
