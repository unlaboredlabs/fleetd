// The lead chat's composer (A3): one box. Typing while the lead works is a steer, otherwise a new message; the hub
// decides (chat_send) and the box only says which to expect. Enter sends, Shift+Enter is a new line, and while the
// lead works ⌘Enter stops its current step and delivers at once (chat_send's `now`); either way it is a chat message
// like any other. ↑ in an empty box brings back your last message. Files
// attach by the box's clip, drop or paste (images included); a long paste becomes a file. While the lead works,
// Stop beside Send ends its turn now. The words, the files and an unsent message's error stay per project across
// navigation, and the words across quitting (drafts.ts). Sent with no hub, a message is queued and goes when the
// link is back. Replying to a bubble puts its quote over the box; what you send then answers it (Esc lets go).

interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

import { ArrowUp, Check, Paperclip, Reply, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { AttachmentRef } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";
import { useData, useDataLayer } from "../../src/data/react";
import { projectKey as keyOf } from "../../src/data/store";
import { selectCanStop, selectHeldLeadWorking, selectLeadWorking } from "../../src/data/selectors";
import { Button, cx, IdChip, StateGlyph, Text, Tooltip, Truncate } from "../../ui";
import { useCommands } from "../palette";
import { nowKeys } from "../live/Steer";
import { composerSendOn } from "../live/steerModel";
import { fmtBytes, PASTE_AS_FILE, pastedName } from "./attachments";
import { ACT_LABEL, checkMessage, placeholder, receiptFor, receiptMark, recallsOn, stopFailed, type Act } from "./composerModel";
import { useDraft, useDrafts } from "./drafts";
import { useSkillPicker } from "./SkillPicker";
import type { ReplyTarget } from "./actions";
import { replyText } from "./bubbles";
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
  /** The bubble your next message answers. */
  replyTo?: ReplyTarget | undefined;
  onCancelReply?: () => void;
  /** Who reads it, when not "the lead": a Navi's name. */
  who?: string | undefined;
}

export function ChatComposer({ project, onSent, autoFocus, recall, replyTo, onCancelReply, who }: ChatComposerProps) {
  const projectKey = keyOf(project);
  const [draft, setDraft, drafts] = useDraft(projectKey);
  const working = useData(selectLeadWorking(projectKey));
  const { chat } = useDataLayer();
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pastes = useRef(0);
  const skills = useSkillPicker(project, draft.text, (text) => setDraft((d) => ({ ...d, text })), box);
  const canStop = useData(selectCanStop);
  // Asked for until the lead's turn ends (or the call says it can't): Stop stays pressed meanwhile.
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();
  // Offline, a lead last known to be working keeps its Stop, disabled, with why under the box.
  const stopOffline = useData(selectHeldLeadWorking(projectKey));
  const showStop = (working === true && canStop) || stopOffline;

  // The turn ended: a new one starts with Stop unpressed.
  const [wasWorking, setWasWorking] = useState(working);
  if (working !== wasWorking) {
    setWasWorking(working);
    if (working !== true) {
      setStopping(false);
      setStopError(undefined);
    }
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
      if (o.t === "failed") setStopError(stopFailed(o.error.code));
    });
  };

  useCommands(
    [
      { id: "composer.focus", title: "Focus the composer", group: "actions", run: () => box.current?.focus() },
      { id: "composer.attach", title: "Attach a file", group: "actions", run: () => fileInput.current?.click() },
      { id: "lead.stop", title: "Stop the lead and its agents", group: "actions", detail: "Ends the lead’s turn and stops the project’s agents", enabled: () => showStop && !stopOffline && !stopping, run: stop },
    ],
    [],
  );

  const attach = (files: readonly File[]) => drafts.attach(projectKey, files);
  const uploading = draft.attached.some((a) => a.upload === undefined);
  const checked = checkMessage(draft.text, draft.attached.length);
  const sendable = checked.ok && !uploading;

  const send = (now = false) => {
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
    // The words leave the box at once; the layer's item holds them (queued when offline, with Edit to take back).
    setDraft(() => ({ text: "", attached: [] }));
    onSent?.();
    // The quote stays in the text for every client; the hub gives the lead the whole bubble `replyTo` names.
    const text = replyTo === undefined || replyTo.quote === "" ? checked.text : replyText(replyTo.quote, checked.text);
    const reply = replyTo === undefined ? {} : { replyTo: { messageId: replyTo.id, part: replyTo.part } };
    const named = skills.named(checked.text);
    void chat.send(projectKey, { text, ...reply, ...(files.length > 0 ? { attachments: files } : {}), ...(now ? { now } : {}), ...(named.length > 0 ? { skills: named } : {}) });
  };

  // A reply goes to the box: the cursor follows it.
  useEffect(() => {
    if (replyTo !== undefined) box.current?.focus();
  }, [replyTo]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (skills.onKeyDown(e)) return;
    const key = { ...e, isComposing: e.nativeEvent.isComposing };
    if (e.key === "Escape" && replyTo !== undefined) {
      e.preventDefault();
      onCancelReply?.();
      return;
    }
    if (recall !== undefined && recallsOn(key, draft)) {
      e.preventDefault();
      setDraft((d) => ({ ...d, text: recall }));
      return;
    }
    const how = composerSendOn(key, working === true);
    if (how === undefined) return;
    e.preventDefault();
    send(how === "now");
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

  // The tools render when what they show changes, not on every key: each is a tooltip, a button and their popper.
  // Their clicks call the latest send and stop.
  const latest = useRef({ send, stop });
  useLayoutEffect(() => {
    latest.current = { send, stop };
  });
  const attachTool = useMemo(
    () => (
      <Tooltip content="Attach a file">
        <Button variant="quiet" iconOnly aria-label="Attach a file" onClick={() => fileInput.current?.click()}>
          <Paperclip />
        </Button>
      </Tooltip>
    ),
    [],
  );
  const stopTool = useMemo(
    () =>
      showStop ? (
        <Tooltip content={stopping ? "Stopping the lead and its agents…" : "Stop the lead and its agents"}>
          <Button variant="secondary" size="md" iconOnly round aria-label={stopping ? "Stopping the lead and its agents" : "Stop the lead and its agents"} disabled={stopping || stopOffline} onClick={() => latest.current.stop()}>
            <Square />
          </Button>
        </Tooltip>
      ) : null,
    [showStop, stopping, stopOffline],
  );
  const sendTool = useMemo(
    () => (
      <Tooltip content="Send">
        <Button variant="primary" size="md" iconOnly round aria-label="Send" disabled={!sendable} onClick={() => latest.current.send()}>
          <ArrowUp />
        </Button>
      </Tooltip>
    ),
    [sendable],
  );

  const note = draft.error;
  const said = note ?? stopError;
  return (
    <div className={c.composer} data-composer data-screen="chat.composer">
      <div className={c.box}>
        {skills.popup}
        {replyTo !== undefined ? (
          <div className={c.replying}>
            <Reply className={c.replyIcon} aria-hidden />
            <span className={c.replyQuote}>
              <Truncate size="xs" tone="quiet" expand="none">
                {replyTo.quote === "" ? "Replying to the lead" : replyTo.quote}
              </Truncate>
            </span>
            <button type="button" className={c.remove} aria-label="Don’t reply to it" onClick={onCancelReply}>
              <X className={c.removeIcon} aria-hidden />
            </button>
          </div>
        ) : null}
        <textarea
          ref={box}
          className={c.input}
          aria-label={`Message ${who ?? "the lead"}`}
          placeholder={placeholder(working, who)}
          rows={1}
          value={draft.text}
          autoFocus={autoFocus}
          onSelect={(e) => skills.track(e.currentTarget)}
          onChange={(e) => {
            skills.track(e.target);
            const text = e.target.value;
            setDraft((d) => {
              const { error: _e, ...rest } = d;
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
          {attachTool}
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
          {working === true ? (
            <Text size="xs" tone="faint">
              {`${nowKeys()} stops its step and sends now`}
            </Text>
          ) : null}
          <span className={c.spacer} />
          {stopTool}
          {sendTool}
        </div>
      </div>
      <div role="status" className={c.note}>
        {said !== undefined ? (
          <Text size="xs" tone="danger">
            {said}
          </Text>
        ) : stopping ? (
          <Text size="xs" tone="quiet">
            Stopping the lead and its agents…
          </Text>
        ) : stopOffline ? (
          <Text size="xs" tone="quiet">
            Offline: stop the lead and its agents once the hub is back.
          </Text>
        ) : null}
      </div>
    </div>
  );
}

/** The quiet line under one of your messages, with Resend / Edit / Dismiss when it didn't go. */
const sendableOf = (item: ChatItem) => ({
  state: item.state,
  error: item.error,
  delivery: item.delivery,
  leadWaiting: item.leadWaiting,
  client: item.message?.client,
});

/**
 * A quiet receipt as a small mark beside your bubble's foot, its words on hover: an open ring of
 * cells while the lead hasn't taken it, a plain check once it has. Nothing under the bubble.
 */
export function ReceiptMarkView({ item, latest }: { item: ChatItem; latest: boolean }) {
  const m = receiptMark(sendableOf(item), latest);
  if (m === undefined) return null;
  return (
    <Tooltip content={m.words}>
      <span className={c.receiptMark} data-mark={m.mark} tabIndex={0} aria-label={m.words}>
        {m.mark === "waiting" ? <StateGlyph state="queued" size="sm" /> : <Check aria-hidden className={c.receiptCheck} strokeWidth={2.5} />}
      </span>
    </Tooltip>
  );
}

export function MessageReceipt({ project, item, latest = false }: { project: ProjectRef; item: ChatItem; latest?: boolean }) {
  const projectKey = keyOf(project);
  const { chat } = useDataLayer();
  const drafts = useDrafts();
  // A quiet receipt is a mark beside the bubble (ReceiptMarkView), never a sentence under it.
  if (receiptMark(sendableOf(item), latest) !== undefined) return null;
  const r = receiptFor(
    {
      state: item.state,
      error: item.error,
      delivery: item.delivery,
      leadWaiting: item.leadWaiting,
      client: item.message?.client,
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
      {r.acts !== undefined && crid !== undefined
        ? r.acts.map((a) => (
            <button key={a} type="button" className={c.linkButton} onClick={() => act(a)}>
              {ACT_LABEL[a]}
            </button>
          ))
        : null}
    </div>
  );
}
