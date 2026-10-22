// The lead chat's composer (A3): one box. Typing while the lead works is a steer, otherwise a new message; the hub
// decides (chat_send) and the box only says which to expect. Enter sends, Shift+Enter is a new line, ↑ in an empty
// box brings back your last message. Files attach by the box's clip, drop or paste (images included); a long paste
// becomes a file. While the lead works, Stop beside Send ends its turn now. The words, the files and an unsent
// message's "not connected" note stay per project across navigation, and the words across quitting (drafts.ts).

interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { AttachmentRef } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";
import { useData, useDataLayer } from "../../src/data/react";
import { projectKey as keyOf } from "../../src/data/store";
import { selectCanStop, selectLeadWorking } from "../../src/data/selectors";
import { Button, cx, IdChip, Text, Tooltip, Truncate } from "../../ui";
import { useCommands } from "../palette";
import { fmtBytes, PASTE_AS_FILE, pastedName } from "./attachments";
import { ACT_LABEL, checkMessage, placeholder, receiptFor, recallsOn, sendsOn, type Act } from "./composerModel";
import { useDraft, useDrafts } from "./drafts";
import c from "./composer.module.css";

const IN_CHAT = '[data-screen="chat"], [data-screen^="chat."]';

/** A folder among the dropped items: that's a project to add, not a file for the lead. */
const hasFolder = (data: DataTransfer): boolean =>
  [...data.items].some((i) => i.kind === "file" && i.webkitGetAsEntry()?.isDirectory === true);

export interface ChatComposerProps {
  project: ProjectRef;
  /** After a message leaves the box: the list scrolls to it. */
  onSent?: () => void;
  autoFocus?: boolean;
  /** Your newest message's words, which ↑ brings back into an empty box. */
  recall?: string | undefined;
}

export function ChatComposer({ project, onSent, autoFocus, recall }: ChatComposerProps) {
  const projectKey = keyOf(project);
  const [draft, setDraft, drafts] = useDraft(projectKey);
  const working = useData(selectLeadWorking(projectKey));
  const { chat } = useDataLayer();
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pastes = useRef(0);
  const canStop = useData(selectCanStop);
  // Asked for until the lead's turn ends (or the call says it can't): Stop stays pressed meanwhile.
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();
  const showStop = working === true && canStop;

  // The turn ended: a new one starts with Stop unpressed.
  const [wasWorking, setWasWorking] = useState(working);
  if (working !== wasWorking) {
    setWasWorking(working);
    if (working !== true) setStopping(false);
  }
  useEffect(() => {
    if (working === true) chat.probeStop();
  }, [working, chat]);

  const stop = () => {
    if (stopping) return;
    setStopping(true);
    setStopError(undefined);
    void chat.stop(projectKey).then((o) => {
      if (o.t === "stopped") return;
      setStopping(false);
      if (o.t === "failed") setStopError(`Couldn’t stop the lead: ${o.error.message}`);
    });
  };

  useCommands(
    [
      { id: "composer.focus", title: "Focus the composer", group: "actions", run: () => box.current?.focus() },
      { id: "composer.attach", title: "Attach a file", group: "actions", run: () => fileInput.current?.click() },
      { id: "lead.stop", title: "Stop the lead", group: "actions", detail: "Ends its turn now; agents keep working", enabled: () => showStop && !stopping, run: stop },
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
    const key = { ...e, isComposing: e.nativeEvent.isComposing };
    if (recall !== undefined && recallsOn(key, draft)) {
      e.preventDefault();
      setDraft((d) => ({ ...d, text: recall }));
      return;
    }
    if (!sendsOn(key)) return;
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

  // A file dropped anywhere on the chat attaches here; a link, or a drop outside the chat, is ProjectsHost's (it
  // listens on the window and leaves a drop alone once it is defaultPrevented). Listened on the document, which the
  // event reaches before the window.
  useEffect(() => {
    const files = (e: DragEvent) =>
      e.dataTransfer?.types.includes("Files") === true && e.target instanceof Element && e.target.closest(IN_CHAT) !== null;
    const claim = (e: DragEvent) => {
      if (!files(e)) return;
      // Nor ProjectsHost's "add it as a project" overlay: here a file is for the lead.
      e.stopPropagation();
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      const data = e.dataTransfer;
      if (data === null || !files(e) || hasFolder(data)) return;
      e.preventDefault();
      drafts.attach(projectKey, [...data.files]);
      box.current?.focus();
    };
    document.addEventListener("dragenter", claim);
    document.addEventListener("dragover", claim);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", claim);
      document.removeEventListener("dragover", claim);
      document.removeEventListener("drop", drop);
    };
  }, [drafts, projectKey]);



  const note = draft.error ?? (draft.offline === true ? "Not connected to the hub, so this wasn’t sent. Send it again once the hub is back." : undefined);
  const said = note ?? stopError;
  return (
    <div className={c.composer} data-composer data-screen="chat.composer">
      <div className={c.box}>
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
        <div className={c.tools}>
          <Tooltip content="Attach a file">
            <Button variant="quiet" iconOnly aria-label="Attach a file" onClick={() => fileInput.current?.click()}>
              <Paperclip />
            </Button>
          </Tooltip>
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
          {showStop ? (
            <Tooltip content={stopping ? "Stopping the lead…" : "Stop the lead now"}>
              <Button variant="secondary" size="md" iconOnly round aria-label={stopping ? "Stopping the lead" : "Stop the lead"} disabled={stopping} onClick={stop}>
                <Square />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content="Send">
            <Button variant="primary" size="md" iconOnly round aria-label="Send" disabled={!sendable} onClick={send}>
              <ArrowUp />
            </Button>
          </Tooltip>
        </div>
      </div>
      <div role="status" className={c.note}>
        {said !== undefined ? (
          <Text size="xs" tone="danger">
            {said}
          </Text>
        ) : stopping ? (
          <Text size="xs" tone="quiet">
            Stopping the lead…
          </Text>
        ) : null}
      </div>
    </div>
  );
}

/** The quiet line under one of your messages, with Resend / Edit / Dismiss when it didn't go. */
export function MessageReceipt({ project, item, latest = false }: { project: ProjectRef; item: ChatItem; latest?: boolean }) {
  const projectKey = keyOf(project);
  const { chat } = useDataLayer();
  const drafts = useDrafts();
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
    // The words and files go back in the box (after any already there); the message goes.
    if (a === "edit") drafts.restore(projectKey, item.text, item.attachments);
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
