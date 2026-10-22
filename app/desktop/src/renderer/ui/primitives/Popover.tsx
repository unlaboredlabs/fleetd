import { Popover as P } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({ className, children, ...rest }: ComponentProps<typeof P.Content> & { children: ReactNode }) {
  return (
    <P.Portal>
      <P.Content className={cx(s.surface, s.popover, className)} sideOffset={6} collisionPadding={8} {...rest}>
        {children}
      </P.Content>
    </P.Portal>
  );
}
