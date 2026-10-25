// Checklists, and an image or clip already on the hub (attachment_get, read once the bubble is on screen).
import { Check, Circle } from "lucide-react";
import type { AttachmentBlock, ChecklistBlock } from "../../../../shared/contracts";
import { useToolQuery } from "../../../src/data/react";
import { cx, Text } from "../../../ui";
import { useBubbleActions } from "../actions";
import b from "./blocks.module.css";

export function Checklist({ list }: { list: ChecklistBlock }) {
  const done = list.items.filter((i) => i.done).length;
  return (
    <div className={b.card} data-block="checklist">
      <div className={b.head}>
        <Text size="sm" strong>
          {list.title ?? "Checklist"}
        </Text>
        <Text size="xs" tone="quiet" tabular>{`${String(done)} of ${String(list.items.length)} done`}</Text>
      </div>
      <ul className={b.checklist}>
        {list.items.map((item, i) => (
          <li key={i} className={cx(b.check, item.done && b.checked)}>
            {item.done ? <Check className={b.checkIcon} aria-label="Done" /> : <Circle className={b.checkIcon} aria-label="To do" />}
            <Text size="md" tone={item.done ? "quiet" : "default"}>
              {item.text}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Media({ media, clip }: { media: AttachmentBlock; clip: boolean }) {
  const project = useBubbleActions()?.project;
  const got = useToolQuery("attachment_get", { projectRef: project ?? { machineId: "", projectId: "" }, attachmentId: media.attachmentId }, { enabled: project !== undefined });
  const data = got.data;
  const src = data === undefined ? undefined : `data:${data.mime};base64,${data.dataB64}`;
  return (
    <figure className={b.media} data-block={clip ? "clip" : "image"}>
      {src === undefined ? (
        <div className={b.mediaWait}>
          <Text size="xs" tone="quiet">
            {got.isError ? "Couldn’t load this." : "Loading…"}
          </Text>
        </div>
      ) : clip && data?.mime.startsWith("video/") === true ? (
        <video className={b.mediaItem} src={src} controls preload="metadata" />
      ) : (
        <img className={b.mediaItem} src={src} alt={media.caption ?? data?.name ?? ""} />
      )}
      {media.caption !== undefined ? (
        <figcaption>
          <Text size="xs" tone="quiet">
            {media.caption}
          </Text>
        </figcaption>
      ) : null}
    </figure>
  );
}
