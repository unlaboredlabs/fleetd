// Undo on a "Remembered: …" or "Forgot: …" line, so a wrong memory has a way out, and the night's "Memory refreshed"
// line: one summary with Undo all, which opens to its changes, each with Undo. The hub re-sends the line marked
// undone, which replaces a button with a word; only a failed Undo is kept here.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ChatMessage, MemoryRefreshed, RememberedItem } from "../../../shared/contracts";
import { Button, cx, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import type { ProjectRef } from "./slots";
import { InlineText } from "./text";
import s from "./view.module.css";

export function RememberedUndo({ project, message }: { project: ProjectRef; message: ChatMessage }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (message.remembered === undefined) return null;
  if (message.remembered.undone) {
    return (
      <Text size="xs" tone="quiet">
        Undone
      </Text>
    );
  }
  const undo = () => {
    setBusy(true);
    setFailed(null);
    void layer.call("memory_undo", { projectRef: project, messageId: message.messageId }).then((out) => {
      setBusy(false);
      if (!out.ok) setFailed(out.error.fix ? `${out.error.message} ${out.error.fix}` : out.error.message);
    });
  };
  return (
    <>
      <Button size="sm" variant="link" disabled={busy} onClick={undo}>
        Undo
      </Button>
      {failed ? (
        <Text size="xs" tone="danger">
          {failed}
        </Text>
      ) : null}
    </>
  );
}

type Kind = "added" | "updated" | "removed";

/** An entry added, one put in place of another, or one removed. */
export const kindOf = (item: RememberedItem): Kind => (item.forgotten ? "removed" : item.replaced !== undefined ? "updated" : "added");

/** "MEMORY.md", "deploys.md" or "user.md". */
export const fileOf = (item: RememberedItem): string => (item.scope === "user" ? "user.md" : item.topic !== undefined ? `${item.topic}.md` : "MEMORY.md");

const SIGN_KIND: Record<string, Kind> = { "+": "added", "~": "updated", "−": "removed" };

/**
 * "Memory tidied: 3 added, 1 updated, 2 removed", over all the refresh's changes: the hub's "+3 ~1 −2" counts them
 * all, the ones past what the line lists too; the listed ones when it says none.
 */
export function tidied(text: string, refreshed: MemoryRefreshed): string {
  const counts: Record<Kind, number> = { added: 0, updated: 0, removed: 0 };
  const said = [...text.matchAll(/([+~−])(\d+)/gu)];
  for (const [, sign, n] of said) counts[SIGN_KIND[sign ?? ""] ?? "added"] += Number(n);
  if (said.length === 0) for (const item of refreshed.items) counts[kindOf(item)] += 1;
  const parts = (["added", "updated", "removed"] as const).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return `Memory tidied: ${parts.join(", ")}`;
}

function useUndo(project: ProjectRef, message: ChatMessage) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const undo = (item?: number) => {
    setBusy(true);
    setFailed(null);
    const input = item === undefined ? { projectRef: project, messageId: message.messageId } : { projectRef: project, messageId: message.messageId, item };
    void layer.call("memory_undo", input).then((out) => {
      setBusy(false);
      if (!out.ok) setFailed(out.error.fix ? `${out.error.message} ${out.error.fix}` : out.error.message);
    });
  };
  return { busy, failed, undo };
}

const KIND_WORD: Record<Kind, string> = { added: "Added", updated: "Updated", removed: "Removed" };

/** One change: what kind, its entry cut to two lines, and Undo. Pressing the entry opens it in full, with what it was. */
function Change({ item, busy, onUndo }: { item: RememberedItem; busy: boolean; onUndo: () => void }) {
  const [open, setOpen] = useState(false);
  const file = fileOf(item);
  return (
    <div role="listitem" className={cx(s.change, item.undone && s.changeUndone)}>
      <span className={s.changeKind}>{KIND_WORD[kindOf(item)]}</span>
      <button type="button" className={s.changeText} aria-expanded={open} title={open ? undefined : item.text.replaceAll("`", "")} onClick={() => setOpen((o) => !o)}>
        <span className={open ? undefined : s.clamp}>
          {file === "MEMORY.md" ? null : <span className={s.changeFile}>{file}: </span>}
          <InlineText size="xs" tone="inherit" text={item.text} />
        </span>
        {open && item.replaced !== undefined ? <InlineText size="xs" tone="quiet" text={`Was: ${item.replaced}`} /> : null}
        {open && item.reason !== undefined ? <InlineText size="xs" tone="quiet" text={`Why: ${item.reason}`} /> : null}
      </button>
      {item.undone ? (
        <span className={s.changeUndo}>Undone</span>
      ) : (
        <Button size="sm" variant="link" className={s.changeUndo} disabled={busy} onClick={onUndo}>
          Undo
        </Button>
      )}
    </div>
  );
}

/**
 * A "Memory refreshed" line: how many entries it added, updated and removed, with Undo all while two or more can be
 * undone, or any the line doesn't list. It opens to each change it lists, with its Undo, then how many more it made.
 */
export function RefreshedChanges({ project, message, refreshed, at }: { project: ProjectRef; message: ChatMessage; refreshed: MemoryRefreshed; at: string }) {
  const { busy, failed, undo } = useUndo(project, message);
  const [shown, setShown] = useState(false);
  const total = refreshed.total ?? refreshed.items.length;
  const unlisted = total - refreshed.items.length;
  const listedOpen = refreshed.items.filter((i) => !i.undone).length;
  // The changes past what the line lists can still be undone, all together, until the hub counts them undone.
  const open = total - (refreshed.undone ?? refreshed.items.length - listedOpen);
  const Chevron = shown ? ChevronDown : ChevronRight;
  return (
    <div data-entry="memory-refreshed">
      <div className={s.event}>
        <button type="button" className={s.disclosure} aria-expanded={shown} onClick={() => setShown((o) => !o)}>
          <Chevron className={s.chevron} aria-hidden />
          <Text size="xs" tone="inherit">
            {tidied(message.text, refreshed)}
          </Text>
        </button>
        {open > 1 || open > listedOpen ? (
          <Button size="sm" variant="link" className={s.changeUndo} disabled={busy} onClick={() => undo()}>
            Undo all
          </Button>
        ) : null}
        <span className={s.eventTime}>{at}</span>
      </div>
      {failed ? (
        <div className={s.event}>
          <Text size="xs" tone="danger">
            {failed}
          </Text>
        </div>
      ) : null}
      {shown ? (
        <div role="list" aria-label="Memory changes" className={s.changes}>
          {refreshed.items.map((item, n) => (
            <Change key={n} item={item} busy={busy} onUndo={() => undo(n)} />
          ))}
          {unlisted > 0 ? (
            <div role="listitem" className={s.change}>
              <span className={s.changeKind} />
              <Text size="xs" tone="quiet">
                and {unlisted} more
              </Text>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
