// The steer composer (steering-spec §7), after T3 Code's follow-up composer (apps/web ComposerPrimaryActions): the
// primary button queues for the agent's next step and reads "Interrupt" while the modifier is held; the secondary
// interrupts and redirects now. Both modes by mouse too.

import { useEffect, useRef, useState, type KeyboardEvent , type RefObject } from "react";
import { Button, cx, Text, Textarea } from "../../ui";
import { keyHint, modKey, placeholder, primaryLabel, secondaryLabel, sendModeFor, type Platform, type SteerWords } from "./composerModel";
import type { SteerMode } from "../../../shared/contracts";
import { useDraft, type SendOutcome } from "./outbox";
import s from "./order.module.css";

/** Whether the platform's modifier is held, while the composer has focus. */
function useModHeld(platform: Platform, active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const on = (e: globalThis.KeyboardEvent) => setHeld(modKey(e, platform));
    const off = () => setHeld(false);
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
      setHeld(false);
    };
  }, [platform, active]);
  return held;
}

export interface SteerComposerProps {
  who: SteerWords;
  platform: Platform;
  /** `requestId` is this composed steer's own: the same if it is sent again. */
  onSend: (text: string, mode: SteerMode, requestId: string) => Promise<SendOutcome>;
  /** Whose box this is (outbox.draftKey): its words and id outlive the view, so leaving the order loses nothing. */
  draftKey: string;
  /** Focus it when it mounts (the steer sheet). */
  autoFocus?: boolean;
  label: string;
  /** The textarea, for "Steer the lead" in the palette. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

export function SteerComposer({ who, platform, onSend, draftKey, autoFocus, label, inputRef }: SteerComposerProps) {
  const [draft, setDraft] = useDraft(draftKey);
  const text = draft.text;
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const held = useModHeld(platform, focused);
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? own;
  const canSend = text.trim() !== "" && !busy;

  const send = (mode: SteerMode) => {
    const body = text.trim();
    if (body === "" || busy) return;
    // One id per composed steer, minted when it is first sent: a second press, a double-click or a retry after
    // no hub answered is the same request, which the hub dedupes.
    const id = draft.requestId ?? crypto.randomUUID();
    setDraft({ text, requestId: id });
    setBusy(true);
    void onSend(body, mode, id).then((outcome) => {
      setBusy(false);
      // No hub: nothing was sent and no row holds the words, so they stay here under the same id. Otherwise the
      // steer's row has them now (its receipt, or not sent with Resend and Edit): the box is for the next steer,
      // unless it was edited meanwhile.
      setDraft((now) => (now.requestId !== id ? now : outcome === "offline" ? { ...now, offline: true } : { text: "" }));
      ref.current?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mode = sendModeFor({ ...e, isComposing: e.nativeEvent.isComposing }, platform);
    if (mode === undefined) return;
    e.preventDefault();
    send(mode);
  };

  return (
    <div className={s.composer} data-composer>
      <Textarea
        ref={ref}
        aria-label={label}
        value={text}
        placeholder={placeholder(who, platform)}
        minRows={2}
        maxRows={10}
        autoFocus={autoFocus}
        onChange={(e) => {
          // Edited words are a new steer.
          setDraft({ text: e.target.value });
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      <div role="status">
        {draft.offline === true ? (
          <Text size="xs" tone="danger">
            Not connected to the hub, so this steer wasn’t sent. Send it again once the hub is back.
          </Text>
        ) : null}
      </div>
      <div className={s.composerFoot}>
        <Text size="xs" tone="quiet" className={cx(s.hint)}>
          {keyHint(who, platform)}
        </Text>
        <div className={s.composerButtons}>
          <Button variant="secondary" disabled={!canSend} onClick={() => send("now")}>
            {secondaryLabel}
          </Button>
          <Button variant="primary" disabled={!canSend} onClick={(e) => send(modKey(e, platform) ? "now" : "queue")}>
            {primaryLabel(held)}
          </Button>
        </div>
      </div>
    </div>
  );
}
