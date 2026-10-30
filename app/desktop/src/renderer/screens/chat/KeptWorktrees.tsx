// The nightly cleanup's "Cleanup kept 6 worktrees with unsaved work" line: one summary, like the memory refresh's,
// which opens to each worktree it kept: its task's title, what only it holds, and its path to copy, so the person can
// push or delete that work and let the next cleanup remove it.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ChatMessage, KeptWorktree, WorktreesKept } from "../../../shared/contracts";
import { Button, copyText, cx, Text } from "../../ui";
import s from "./view.module.css";

/** "1 unpushed commit", with "on devbox" when the worktree is on another machine than the project. */
export function keptDetail(item: KeptWorktree, projectMachine: string): string {
  return item.machineId === projectMachine ? item.unsaved : `${item.unsaved} on ${item.machineId}`;
}

function Kept({ item, projectMachine }: { item: KeptWorktree; projectMachine: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div role="listitem" className={s.kept}>
      <span className={s.keptTitle}>
        {item.title} <span className={s.keptDetail}>· {keptDetail(item, projectMachine)}</span>
      </span>
      <code className={s.keptPath}>{item.path}</code>
      <Button size="sm" variant="link" className={s.changeUndo} aria-label={`Copy the path of ${item.title}`} onClick={() => void copyText(item.path).then(setCopied)}>
        {copied === true ? "Copied" : copied === false ? "Not copied" : "Copy"}
      </Button>
    </div>
  );
}

export function KeptWorktrees({ message, kept, at }: { message: ChatMessage; kept: WorktreesKept; at: string }) {
  const [shown, setShown] = useState(false);
  const Chevron = shown ? ChevronDown : ChevronRight;
  return (
    <div data-entry="worktrees-kept">
      <div className={s.event}>
        <button type="button" className={s.disclosure} aria-expanded={shown} onClick={() => setShown((o) => !o)}>
          <Chevron className={s.chevron} aria-hidden />
          <Text size="xs" tone="inherit">
            {message.text}
          </Text>
        </button>
        <span className={s.eventTime}>{at}</span>
      </div>
      {shown ? (
        <div role="list" aria-label="Worktrees kept" className={cx(s.changes, s.keptList)}>
          {kept.items.map((item) => (
            <Kept key={`${item.machineId}:${item.path}`} item={item} projectMachine={message.projectRef.machineId} />
          ))}
          <Text size="xs" tone="quiet">
            Push or delete that work and the next cleanup removes the worktree.
          </Text>
        </div>
      ) : null}
    </div>
  );
}
