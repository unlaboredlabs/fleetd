// The lead chat's composer (A3): one box. Typing while the lead works is a steer, otherwise a new message; the hub
// decides (chat_send) and the box only says which to expect. Enter sends, Shift+Enter is a new line. Files attach
// by button, drop or paste (images included); a long paste becomes a file. The words, the files and an unsent
// message's "not connected" note stay per project across navigation (drafts.ts).

interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

import { Paperclip, X } from "lucide-react";
import { useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { AttachmentRef } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";
import { useData, useDataLayer } from "../../src/data/react";
import { projectKey as keyOf } from "../../src/data/store";
import { selectLeadWorking } from "../../src/data/selectors";
import { Button, cx, IdChip, Text, Truncate } from "../../ui";
import { useCommands } from "../palette";
import { fmtBytes, PASTE_AS_FILE, pastedName } from "./attachments";
import { ACT_LABEL, checkMessage, KEY_HINT, placeholder, receiptFor, sendsOn, type Act } from "./composerModel";
import { useDraft } from "./drafts";
import c from "./composer.module.css";

export interface ChatComposerProps {
  project: ProjectRef;
  /** After a message leaves the box: the list scrolls to it. */
  onSent?: () => void;
  autoFocus?: boolean;
}

export function ChatComposer({ project, onSent, autoFocus }: ChatComposerProps) {
  const projectKey = keyOf(project);
  const [draft, setDraft, drafts] = useDraft(projectKey);
  const working = useData(selectLeadWorking(projectKey));
  const { chat } = useDataLayer();
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pastes = useRef(0);

  useCommands(
    [
      { id: "composer.focus", title: "Focus the composer", group: "actions", run: () => box.current?.focus() },
      { id: "composer.attach", title: "Attach a file", group: "actions", run: () => fileInput.current?.click() },
    ],
    [],
  );

  const attach = (files: readonly File[]) => drafts.attach(projectKey, files);
  const uploading = draft.attached.some((a) => a.upload === undefined);
  const checked = checkMessage(draft.text, draft.attached.length);
  const sendable = checked.ok && !uploading;

  const send = () => {
    if (!checked.ok) {
      if (checked.reason !== "") setDraft((d) => ({ ...d, error: checked.reason }));
      return;
    }
    const files: AttachmentRef[] = [];
    for (const a of draft.attached) {
      const up = a.upload;
      if (!up) return setDraft((d) => ({ ...d, error: `${a.name} is still uploading.` }));
      if (!up.ok) return setDraft((d) => ({ ...d, error: `${a.name} didn’t upload: ${up.message} Remove it to send.` }));
      files.push(up.ref);
    }
    const sent = { text: draft.text, attached: draft.attached };
    // The words leave the box at once; the layer's item holds them (and offers Edit if they don't go).
    setDraft(() => ({ text: "", attached: [] }));
    onSent?.();
    void chat.send(projectKey, { text: checked.text, ...(files.length > 0 ? { attachments: files } : {}) }).then((outcome) => {
      // No hub: nothing was sent and no item holds the words, so they come back, unless new ones were typed.
      if (outcome !== "offline") return;
      setDraft((d) => (d.text === "" && d.attached.length === 0 ? { ...sent, offline: true } : d));
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!sendsOn({ ...e, isComposing: e.nativeEvent.isComposing })) return;
    e.preventDefault();
    send();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length > 0) {
      e.preventDefault();
      // A pasted screenshot is "image.png" on every platform: number it so two read apart.
      return attach(
        files.map((f) => {
          if (!f.type.startsWith("image/")) return f;
          pastes.current += 1;
          return new File([f], pastedName(f.type, pastes.current), { type: f.type });
        }),
      );
    }
    const pasted = e.clipboardData.getData("text/plain");
    if (pasted.length > PASTE_AS_FILE) {
      e.preventDefault();
      pastes.current += 1;
      attach([new File([pasted], pastedName("text/plain", pastes.current), { type: "text/plain" })]);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    attach([...e.dataTransfer.files]);
  };

  const note = draft.error ?? (draft.offline === true ? "Not connected to the hub, so this wasn’t sent. Send it again once the hub is back." : undefined);
  return (
    <div className={c.composer} data-composer data-screen="chat.composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <textarea
        ref={box}
        className={c.input}
        aria-label="Message the lead"
        placeholder={placeholder(working)}
        rows={1}
        value={draft.text}
        autoFocus={autoFocus}
        onChange={(e) => {
          const text = e.target.value;
          setDraft((d) => {
            const { offline: _o, error: _e, ...rest } = d;
            return { ...rest, text };
          });
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {draft.attached.length > 0 ? (
        <div className={c.chips}>
          {draft.attached.map((a) => (
            <span key={a.local} className={cx(c.chip, a.upload && !a.upload.ok && c.failed)}>
              <Truncate expand="none" size="xs" tone="inherit">
                {`${a.name} · ${a.upload ? (a.upload.ok ? fmtBytes(a.bytes) : "didn’t upload") : "uploading…"}`}
              </Truncate>
              <button
                type="button"
                className={c.remove}
                aria-label={`Remove ${a.name}`}
                onClick={() => setDraft((d) => ({ ...d, attached: d.attached.filter((x) => x.local !== a.local) }))}
              >
                <X className={c.removeIcon} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className={c.how}>
        <Button variant="quiet" icon={<Paperclip />} onClick={() => fileInput.current?.click()}>
          Attach
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            attach([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <span className={c.spacer} />
        <span role="status" className={c.note}>
          {note ? (
            <Text size="xs" tone="danger">
              {note}
            </Text>
          ) : (
            <span className={c.keys}>{KEY_HINT}</span>
          )}
        </span>
        <Button variant="primary" disabled={!sendable} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}

/** The quiet line under one of your messages, with Resend / Edit / Dismiss when it didn't go. */
export function MessageReceipt({ project, item, latest = false }: { project: ProjectRef; item: ChatItem; latest?: boolean }) {
  const projectKey = keyOf(project);
  const { chat } = useDataLayer();
  const [, setDraft] = useDraft(projectKey);
  const r = receiptFor(
    {
      state: item.state,
      error: item.error === undefined ? undefined : { ...item.error, ...(item.offline === true ? { offline: true } : {}) },
      delivery: item.delivery,
      leadWaiting: item.leadWaiting,
    },
    latest,
  );
  if (r === undefined) return null;
  const crid = item.clientRequestId;
  const act = (a: Act) => {
    if (crid === undefined) return;
    if (a === "resend") return void chat.retry(projectKey, crid);
    if (a === "edit") {
      // The words go back in the box (after any already there); the message goes.
      setDraft((d) => ({ ...d, text: d.text.trim() === "" ? item.text : `${d.text}\n\n${item.text}` }));
    }
    chat.discard(projectKey, crid);
  };
  return (
    <div className={cx(c.receipt, c[`tone-${r.kind}`])} data-receipt={item.state}>
      <Text size="xs" tone="inherit">
        {r.line}
      </Text>
      {r.kind === "bad" && r.detail ? <IdChip label="Details" id={r.detail} kind="error" size="xs" tone="quiet" /> : null}
      {r.kind !== "quiet" && crid !== undefined
        ? r.acts.map((a) => (
            <button key={a} type="button" className={c.linkButton} onClick={() => act(a)}>
              {ACT_LABEL[a]}
            </button>
          ))
        : null}
    </div>
  );
}
