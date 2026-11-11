import { Tooltip as T } from "radix-ui";
import { createContext, useContext, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

const Provided = createContext(false);

/** One provider at the root (inside <UiProvider>), so moving between tooltips skips the delay. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Provided.Provider value>
      <T.Provider delayDuration={500} skipDelayDuration={300}>
        {children}
      </T.Provider>
    </Provided.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Where along that side: the trigger's middle unless said. `offset` moves it along the side, `gap` off it. */
  align?: "start" | "center" | "end";
  offset?: number;
  gap?: number;
  /**
   * A sentence or two rather than a name: wider, in the text's own size (a Settings row's explanation). It leaves the
   * moment the pointer leaves the trigger, and never takes a press meant for what it covers.
   */
  prose?: boolean;
  /** Controlled open state; Truncate uses it to show only when the text is cut. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A plain-text hint. The trigger must be a single focusable element (or forward its ref); one that only holds what
 * takes focus shows the hint while focus is inside it.
 */
export function Tooltip({ content, children, side = "top", align = "center", offset = 0, gap = 6, prose = false, open, onOpenChange }: TooltipProps) {
  const [own, setOwn] = useState(false);
  const provided = useContext(Provided);
  if (content == null || content === "") return <>{children}</>;
  const shown = open ?? own;
  const change = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  const tip = (
    <T.Root open={shown} onOpenChange={change} disableHoverableContent={prose}>
      <T.Trigger asChild>{children}</T.Trigger>
      {/* Gone the moment it closes. Left to Radix, a closed tooltip stays until its fade reports an end, and when the
          fade's start went unseen (a press, or reduced motion's 0 ms fade) that end never comes. */}
      {shown ? (
        <T.Portal>
          <T.Content className={cx(s.tooltip, prose && s.prose)} side={side} sideOffset={gap} align={align} alignOffset={offset} collisionPadding={8}>
            {content}
          </T.Content>
        </T.Portal>
      ) : null}
    </T.Root>
  );
  // Outside the app's provider (a part rendered alone) it brings its own.
  return provided ? tip : <TooltipProvider>{tip}</TooltipProvider>;
}
