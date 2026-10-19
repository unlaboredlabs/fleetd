// The steer composer (steering-spec §7), after T3 Code's follow-up composer (apps/web ComposerPrimaryActions): the
// primary button queues for the agent's next step and reads "Interrupt" while the modifier is held; the secondary
// interrupts and redirects now. Both modes by mouse too.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, cx, Text, Textarea } from "../../ui";
import { keyHint, modKey, placeholder, primaryLabel, secondaryLabel, sendModeFor, type Platform, type SteerWords } from "./composer";
import type { SteerMode } from "./contracts";
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
  onSend: (text: string, mode: SteerMode) => void;
  /** Focus it when it mounts (the steer sheet). */
  autoFocus?: boolean;
  label: string;
}

export function SteerComposer({ who, platform, onSend, autoFocus, label }: SteerComposerProps) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const held = useModHeld(platform, focused);
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim() !== "";

  const send = (mode: SteerMode) => {
    const body = text.trim();
    if (body === "") return;
    onSend(body, mode);
    setText("");
    ref.current?.focus();
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
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
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
