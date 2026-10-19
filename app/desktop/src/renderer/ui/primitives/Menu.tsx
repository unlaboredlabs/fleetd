import { ContextMenu as C, DropdownMenu as D } from "radix-ui";
import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

/*
 * Menus: a dropdown (from a button) and a context menu (right click) with the same items and look. Item labels
 * wrap instead of clipping; a hint (shortcut) sits on the right.
 */

export const Menu = D.Root;
export const MenuTrigger = D.Trigger;
export const MenuGroup = D.Group;
export const MenuRadioGroup = D.RadioGroup;
export const MenuSub = D.Sub;

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

export function MenuCheckboxItem({ hint, className, children, ...rest }: ComponentProps<typeof D.CheckboxItem> & ItemExtras) {
  return (
    <D.CheckboxItem className={cx(s.item, className)} {...rest}>
      <span className={s.indicator}>
        <D.ItemIndicator>
          <Check />
        </D.ItemIndicator>
      </span>
      <ItemInner hint={hint}>{children}</ItemInner>
    </D.CheckboxItem>
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

export function MenuLabel({ className, ...rest }: ComponentProps<typeof D.Label>) {
  return <D.Label className={cx(s.groupLabel, className)} {...rest} />;
}

export function MenuSeparator() {
  return <D.Separator className={s.separator} />;
}

export function MenuSubTrigger({ icon, className, children, ...rest }: ComponentProps<typeof D.SubTrigger> & ItemExtras) {
  return (
    <D.SubTrigger className={cx(s.item, className)} {...rest}>
      <ItemInner icon={icon} hint="›">
        {children}
      </ItemInner>
    </D.SubTrigger>
  );
}

export function MenuSubContent({ className, ...rest }: ComponentProps<typeof D.SubContent>) {
  return (
    <D.Portal>
      <D.SubContent className={cx(s.surface, className)} sideOffset={4} collisionPadding={8} {...rest} />
    </D.Portal>
  );
}

export const ContextMenu = C.Root;
export const ContextMenuTrigger = C.Trigger;

export function ContextMenuContent({ className, ...rest }: ComponentProps<typeof C.Content>) {
  return (
    <C.Portal>
      <C.Content className={cx(s.surface, className)} collisionPadding={8} {...rest} />
    </C.Portal>
  );
}

export function ContextMenuItem({ icon, hint, danger, className, children, ...rest }: ComponentProps<typeof C.Item> & ItemExtras) {
  return (
    <C.Item className={cx(s.item, danger && s.danger, className)} {...rest}>
      <ItemInner icon={icon} hint={hint}>
        {children}
      </ItemInner>
    </C.Item>
  );
}

export function ContextMenuSeparator() {
  return <C.Separator className={s.separator} />;
}
