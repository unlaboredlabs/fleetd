import { Tooltip as T } from "radix-ui";
import { useState, type ReactNode } from "react";
import s from "./Overlay.module.css";

/** One provider at the root (inside <UiProvider>), so moving between tooltips skips the delay. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={500} skipDelayDuration={300}>
      {children}
    </T.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Controlled open state; Truncate uses it to show only when the text is cut. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** A plain-text hint. The trigger must be a single focusable element (or forward its ref). */
export function Tooltip({ content, children, side = "top", open, onOpenChange }: TooltipProps) {
  const [own, setOwn] = useState(false);
  if (content == null || content === "") return <>{children}</>;
  const shown = open ?? own;
  const change = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <T.Root open={shown} onOpenChange={change}>
      <T.Trigger asChild>{children}</T.Trigger>
      {/* Gone the moment it closes. Left to Radix, a closed tooltip stays until its fade reports an end, and when the
          fade's start went unseen (a press, or reduced motion's 0 ms fade) that end never comes. */}
      {shown ? (
        <T.Portal>
          <T.Content className={s.tooltip} side={side} sideOffset={6} collisionPadding={8}>
            {content}
          </T.Content>
        </T.Portal>
      ) : null}
    </T.Root>
  );
}
