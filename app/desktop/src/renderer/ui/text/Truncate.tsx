import { useLayoutEffect, useRef, useState, type ElementType, type KeyboardEvent, type MouseEvent } from "react";
import { Copy } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { Tooltip } from "../primitives/Tooltip";
import { textClass, type TextStyleProps } from "./Text";
import { isCut, observeSize } from "./observeSize";
import s from "./text.module.css";

export interface TruncateProps extends TextStyleProps {
  /** The full text. Plain text only, so the tooltip and the copy hold exactly what was cut. */
  children: string;
  as?: ElementType;
  /** Lines before the ellipsis; 1 for titles, breadcrumbs, branch names and table cells. */
  lines?: number;
  /**
   * What a click on cut text does: `popover` shows the full text with Copy (default), `inline` unfolds it in
   * place, `none` only tooltips (inside a row that opens the item on click, so the click stays the row's).
   */
  expand?: "popover" | "inline" | "none";
  inline?: boolean;
  className?: string | undefined;
}

/**
 * A single-line (or clamped) slot. When the text does not fit it ends in an ellipsis, the full text shows in a
 * tooltip on hover, and a click expands or copies it. When it fits, it is plain text with no affordances.
 */
export function Truncate({ children, as: As = "span", lines = 1, expand = "popover", inline, className, ...style }: TruncateProps) {
  const ref = useRef<HTMLElement>(null);
  const [cut, setCut] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setCut(isCut(el));
    measure();
    return observeSize(el, measure);
  }, [children, lines, expanded]);

  const onTip = (open: boolean) => {
    const el = ref.current;
    setTipOpen(open && !popOpen && el !== null && isCut(el));
  };

  const interactive = cut && expand !== "none";

  if (expanded) {
    return (
      <As
        ref={ref}
        data-text="wrap"
        className={cx(s.text, s.expanded, textClass(style), s.clickable, className)}
        title="Click to fold"
        onClick={() => setExpanded(false)}
      >
        {children}
      </As>
    );
  }

  const clamp = lines > 1;
  const node = (
    <As
      ref={ref}
      data-text="truncate"
      className={cx(clamp ? s.clamp : s.truncate, inline && s.inline, textClass(style), interactive && s.clickable, className)}
      style={clamp ? { WebkitLineClamp: lines } : undefined}
      {...(interactive
        ? {
            tabIndex: 0,
            role: "button",
            "aria-label": children,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              if (expand === "inline") setExpanded(true);
            },
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              if (expand === "inline") setExpanded(true);
              else setPopOpen(true);
            },
          }
        : {})}
    >
      {children}
    </As>
  );

  const tipped = (
    <Tooltip content={children} open={tipOpen} onOpenChange={onTip}>
      {expand === "popover" && cut ? <PopoverTrigger asChild>{node}</PopoverTrigger> : node}
    </Tooltip>
  );

  if (expand !== "popover" || !cut) return tipped;
  return (
    <Popover
      open={popOpen}
      onOpenChange={(open) => {
        setPopOpen(open);
        if (open) setTipOpen(false);
      }}
    >
      {tipped}
      <PopoverContent align="start" onClick={(e) => e.stopPropagation()}>
        <FullText text={children} style={style} />
      </PopoverContent>
    </Popover>
  );
}

function FullText({ text, style }: { text: string; style: TextStyleProps }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div data-text="wrap" className={cx(s.text, s.pre, s.popoverText, textClass({ ...style, size: style.mono ? "sm" : "md" }))}>
        {text}
      </div>
      <div className={s.popoverActions}>
        <Button
          variant="ghost"
          icon={<Copy />}
          onClick={() => {
            void copyText(text).then((ok) => {
              setCopied(ok);
              if (ok) window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </>
  );
}
