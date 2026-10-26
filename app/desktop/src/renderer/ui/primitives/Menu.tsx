import { DropdownMenu as D } from "radix-ui";
import { Check } from "lucide-react";
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

/*
 * A dropdown menu (from a button). Item labels wrap instead of clipping; a hint (shortcut) sits on the right.
 */

const Open = createContext(false);

export function Menu({ open, onOpenChange, defaultOpen, ...rest }: ComponentProps<typeof D.Root>) {
  const [own, setOwn] = useState(defaultOpen ?? false);
  const shown = open ?? own;
  return (
    <Open.Provider value={shown}>
      <D.Root
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
export const MenuTrigger = D.Trigger;
export const MenuRadioGroup = D.RadioGroup;

export function MenuContent({ className, ...rest }: ComponentProps<typeof D.Content>) {
  // Gone the moment it closes, as a tooltip is: left to Radix, a closed menu stays until its entrance reports an end,
  // which never comes when its start went unseen.
  return useContext(Open) ? (
    <D.Portal>
      <D.Content className={cx(s.surface, className)} sideOffset={4} collisionPadding={8} align="start" {...rest} />
    </D.Portal>
  ) : null;
}

interface ItemExtras {
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
}

function ItemInner({ icon, hint, children }: ItemExtras & { children: ReactNode }) {
  return (
    <>
      {icon}
      <span className={s.itemLabel} data-text="wrap">
        {children}
      </span>
      {hint ? <span className={s.itemHint}>{hint}</span> : null}
    </>
  );
}

export function MenuItem({ icon, hint, danger, className, children, ...rest }: ComponentProps<typeof D.Item> & ItemExtras) {
  return (
    <D.Item className={cx(s.item, danger && s.danger, className)} {...rest}>
      <ItemInner icon={icon} hint={hint}>
        {children}
      </ItemInner>
    </D.Item>
  );
}

export function MenuRadioItem({ hint, className, children, ...rest }: ComponentProps<typeof D.RadioItem> & ItemExtras) {
  return (
    <D.RadioItem className={cx(s.item, className)} {...rest}>
      <span className={s.indicator}>
        <D.ItemIndicator>
          <Check />
        </D.ItemIndicator>
      </span>
      <ItemInner hint={hint}>{children}</ItemInner>
    </D.RadioItem>
  );
}

export function MenuSeparator() {
  return <D.Separator className={s.separator} />;
}
