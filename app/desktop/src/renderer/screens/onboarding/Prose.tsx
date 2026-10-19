import { useState } from "react";
import type { PairFailure } from "../../../shared/pairing";
import { Button, copyText, InlineCode, Text, type TextSize, type TextTone } from "../../ui";
import s from "./onboarding.module.css";

/** A sentence from the hub or the app, with its `commands` shown as code rather than as backticks. */
export function Prose({ text, tone = "default", size = "md" }: { text: string; tone?: TextTone; size?: TextSize }) {
  const parts = text.split("`");
  return (
    <Text as="p" tone={tone} size={size}>
      {parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? <InlineCode key={i}>{part}</InlineCode> : part))}
    </Text>
  );
}

/** A command to run elsewhere, with a Copy button. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={s.command}>
      <Text mono size="sm">
        {command}
      </Text>
      <Button
        variant="ghost"
        onClick={() => {
          void copyText(command).then((ok) => {
            setCopied(ok);
          });
        }}
        onBlur={() => setCopied(false)}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** What went wrong and the fix, selectable so either can be copied. */
export function Failure({ failure }: { failure: PairFailure }) {
  return (
    <div className={s.failure} role="alert">
      <Prose text={failure.message} tone="danger" />
      {failure.fix === undefined ? null : <Prose text={failure.fix} />}
    </div>
  );
}
