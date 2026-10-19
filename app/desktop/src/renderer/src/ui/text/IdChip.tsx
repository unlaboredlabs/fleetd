import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copyText } from "../lib/clipboard";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import { Tooltip } from "../primitives/Tooltip";
import type { TextStyleProps } from "./Text";
import { Truncate } from "./Truncate";
import s from "./text.module.css";

export interface IdChipProps extends TextStyleProps {
  /** What a person calls it: the order title, the project name, the machine name. */
  label: string;
  /** The raw id, hash or key. Never shown as text; it sits behind the copy control. */
  id: string;
  /** What kind of id, for the control's wording ("order", "commit", "thread"). */
  kind?: string;
  /** Inside a clickable row: the label only tooltips, the row keeps the click. */
  inRow?: boolean;
  className?: string;
}

/**
 * A human label with its internal id behind a copy control. The id is on the button's tooltip and in the
 * clipboard, never in the visible text, so the QA gate's raw-id check holds by construction.
 */
export function IdChip({ label, id, kind = "", inRow, className, ...style }: IdChipProps) {
  const [copied, setCopied] = useState(false);
  const noun = kind ? `${kind} id` : "id";
  return (
    <span className={cx(s.idChip, className)} data-id={id}>
      <Truncate expand={inRow ? "none" : "popover"} {...style}>
        {label}
      </Truncate>
      <Tooltip content={copied ? "Copied" : `Copy ${noun}: ${id}`}>
        <Button
          variant="quiet"
          iconOnly
          className={s.idCopy}
          aria-label={`Copy ${noun}`}
          {...(copied ? { "data-copied": "" } : {})}
          onClick={(e) => {
            e.stopPropagation();
            void copyText(id).then((ok) => {
              setCopied(ok);
              if (ok) window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </Tooltip>
    </span>
  );
}
