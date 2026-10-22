import { DropdownMenu as D } from "radix-ui";
import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

/*
 * A dropdown menu (from a button). Item labels wrap instead of clipping; a hint (shortcut) sits on the right.
 */

export const Menu = D.Root;
export const MenuTrigger = D.Trigger;
export const MenuRadioGroup = D.RadioGroup;

export function MenuContent({ className, ...rest }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Content className={cx(s.surface, className)} sideOffset={4} collisionPadding={8} align="start" {...rest} />
    </D.Portal>
  );
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
