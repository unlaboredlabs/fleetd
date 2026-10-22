import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "quiet" | "danger" | "link";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A square button holding only an icon; give it an aria-label. */
  iconOnly?: boolean;
  /** With iconOnly: a circle, for a box's own send and stop. */
  round?: boolean;
  /** An icon before the label. */
  icon?: ReactNode;
  /** A shortcut shown after the label, as quiet text ("⌘↵"). */
  shortcut?: string;
}

/**
 * The one button. Disabled is real: the native attribute (no clicks, no focus), the faint colour, and no hover.
 * Labels never wrap;
 * pass `title` when a label can be too long for its slot (it ends in an ellipsis).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "sm", iconOnly, round, icon, shortcut, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(s.button, s[variant], s[size], iconOnly && s.icon, iconOnly && round && s.round, className)}
      {...rest}
    >
      {icon}
      {children != null && !iconOnly ? <span className={s.label}>{children}</span> : iconOnly ? children : null}
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </button>
  );
});

/** A key or chord, as quiet text in a hairline box. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}
