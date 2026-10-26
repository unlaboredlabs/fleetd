import { Popover as P } from "radix-ui";
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

const Open = createContext(false);

export function Popover({ open, onOpenChange, defaultOpen, ...rest }: ComponentProps<typeof P.Root>) {
  const [own, setOwn] = useState(defaultOpen ?? false);
  const shown = open ?? own;
  return (
    <Open.Provider value={shown}>
      <P.Root
        {...rest}
        open={shown}
        onOpenChange={(next) => {
          setOwn(next);
          onOpenChange?.(next);
        }}
      />
    </Open.Provider>
  );
}
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({ className, children, ...rest }: ComponentProps<typeof P.Content> & { children: ReactNode }) {
  // Gone the moment it closes, as a tooltip is: left to Radix, a closed popover stays until its entrance reports an
  // end, which never comes when its start went unseen.
  return useContext(Open) ? (
    <P.Portal>
      <P.Content className={cx(s.surface, s.popover, className)} sideOffset={6} collisionPadding={8} {...rest}>
        {children}
      </P.Content>
    </P.Portal>
  ) : null;
}
