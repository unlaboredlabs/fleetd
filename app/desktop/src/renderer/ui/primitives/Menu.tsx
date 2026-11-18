import { DropdownMenu as D } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

/*
 * A dropdown menu (from a button): compact rows, keyboard navigation and typeahead (Radix), a quiet label over a group,
 * thin separators; a shortcut or a choice's tick sits at a row's end. Item labels wrap instead of clipping.
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

export function MenuRadioItem({ icon, hint, className, children, ...rest }: ComponentProps<typeof D.RadioItem> & ItemExtras) {
  return (
    <D.RadioItem className={cx(s.item, className)} {...rest}>
      <ItemInner icon={icon} hint={hint}>
        {children}
      </ItemInner>
      <span className={s.indicator}>
        <D.ItemIndicator>
          <Check />
        </D.ItemIndicator>
      </span>
    </D.RadioItem>
  );
}

/** A choice that is on or off, its tick at the row's end. */
export function MenuCheckboxItem({ icon, className, children, ...rest }: ComponentProps<typeof D.CheckboxItem> & Pick<ItemExtras, "icon">) {
  return (
    <D.CheckboxItem className={cx(s.item, className)} {...rest}>
      {icon}
      <span className={s.itemLabel} data-text="wrap">
        {children}
      </span>
      <span className={s.indicator}>
        <D.ItemIndicator>
          <Check />
        </D.ItemIndicator>
      </span>
    </D.CheckboxItem>
  );
}

/** A group's quiet word over its rows. */
export function MenuLabel({ className, ...rest }: ComponentProps<typeof D.Label>) {
  return <D.Label className={cx(s.label, className)} {...rest} />;
}

export const MenuGroup = D.Group;

/** A row that opens more rows beside it (Appearance's three). */
export function MenuSub({ label, icon, hint, children }: { label: ReactNode; icon?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <D.Sub open={open} onOpenChange={setOpen}>
      <D.SubTrigger className={s.item}>
        {icon}
        <span className={s.itemLabel} data-text="wrap">
          {label}
        </span>
        {hint ? <span className={s.itemHint}>{hint}</span> : null}
        <ChevronRight className={s.subChevron} aria-hidden />
      </D.SubTrigger>
      {open ? (
        <D.Portal>
          <D.SubContent className={s.surface} sideOffset={6} collisionPadding={8}>
            {children}
          </D.SubContent>
        </D.Portal>
      ) : null}
    </D.Sub>
  );
}

export function MenuSeparator() {
  return <D.Separator className={s.separator} />;
}
