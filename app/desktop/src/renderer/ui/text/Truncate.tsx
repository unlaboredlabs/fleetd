import { memo, useLayoutEffect, useRef, useState, type ElementType, type KeyboardEvent, type MouseEvent } from "react";
import { Copy } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import { Popover, PopoverAnchor, PopoverContent } from "../primitives/Popover";
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
   * What a click (or Enter) on cut text does: `popover` shows the full text with Copy (default), `inline` unfolds
   * it in place, `none` only tooltips (inside a row that opens the item on click, so the click stays the row's).
   */
  expand?: "popover" | "inline" | "none";
  inline?: boolean;
  className?: string | undefined;
}

/**
 * A single-line (or clamped) slot. When the text does not fit it ends in an ellipsis, the full text shows in a
 * tooltip on hover, and the text becomes a focusable button whose click or Enter expands or copies it. When it
 * fits, it is plain text with no affordances. Memoized: its props are a string and a few flags, and each one is a
 * tooltip and a popover, so a row or a list that renders again leaves its truncated text alone.
 */
export const Truncate = memo(function Truncate({ children, as: As = "span", lines = 1, expand = "popover", inline, className, ...style }: TruncateProps) {
  // The element lives in state (a callback ref), so the observer follows it when React swaps the node.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const refocus = useRef(false);

  useLayoutEffect(() => {
    // Right after a swap this can still hold the node React just removed; the next run has the new one.
    if (!el?.isConnected) return;
    if (refocus.current) {
      refocus.current = false;
      el.focus();
    }
    if (expanded) return;
    const measure = () => setCut(isCut(el));
    measure();
    return observeSize(el, measure);
  }, [el, children, lines, expanded]);

  const toggleInline = (next: boolean, fromKeyboard: boolean) => {
    refocus.current = fromKeyboard;
    setExpanded(next);
  };

  if (expanded) {
    return (
      <As
        ref={setEl}
        data-text="wrap"
        tabIndex={0}
        role="button"
        aria-expanded
        className={cx(s.text, s.expanded, textClass(style), s.clickable, className)}
        title="Click to fold"
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          toggleInline(false, false);
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " " && e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          toggleInline(false, true);
        }}
      >
        {children}
      </As>
    );
  }

  const interactive = cut && expand !== "none";
  const open = (fromKeyboard: boolean) => {
    setTipOpen(false);
    if (expand === "inline") toggleInline(true, fromKeyboard);
    else setPopOpen(true);
  };
  const clamp = lines > 1;
  const node = (
    <As
      ref={setEl}
      data-text="truncate"
      className={cx(clamp ? s.clamp : s.truncate, inline && s.inline, textClass(style), interactive && s.clickable, className)}
      style={clamp ? { WebkitLineClamp: lines } : undefined}
      {...(interactive
        ? {
            tabIndex: 0,
            role: "button",
            "aria-label": children,
            "aria-haspopup": expand === "popover" ? ("dialog" as const) : undefined,
            "aria-expanded": expand === "popover" ? popOpen : false,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              open(false);
            },
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              open(true);
            },
          }
        : {})}
    >
      {children}
    </As>
  );

  const tipped = (
    <Tooltip content={children} open={tipOpen} onOpenChange={(o) => setTipOpen(o && !popOpen && el !== null && isCut(el))}>
      {expand === "popover" ? <PopoverAnchor asChild>{node}</PopoverAnchor> : node}
    </Tooltip>
  );
  if (expand !== "popover") return tipped;

  // One stable tree whether or not the text is cut; only `open` depends on it.
  return (
    <Popover open={popOpen && cut} onOpenChange={setPopOpen}>
      {tipped}
      <PopoverContent
        align="start"
        onClick={(e) => e.stopPropagation()}
        onCloseAutoFocus={(e) => {
          // The anchor is not a Radix trigger, so return focus to the text ourselves.
          e.preventDefault();
          el?.focus();
        }}
      >
        <FullText text={children} style={style} />
      </PopoverContent>
    </Popover>
  );
});

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
