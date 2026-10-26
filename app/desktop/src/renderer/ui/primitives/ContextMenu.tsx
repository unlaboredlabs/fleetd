import { ChevronRight } from "lucide-react";
import { ContextMenu as C } from "radix-ui";
import { useRef, useState, type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { copyText } from "../lib/clipboard";
import { cx } from "../lib/cx";
import { toast } from "./Toast";
import s from "./Overlay.module.css";

/*
 * A right-click menu on one element, drawn as the dropdown menus are. It opens from the keyboard too: Shift+F10 or
 * the Menu key on the element or anything focused inside it. With text selected inside it, Copy selection comes
 * first. A text field inside it keeps the native edit menu (main's editMenu.ts), and an inner element's own menu (a
 * link in a message) wins over its container's.
 */

const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** The event came from a text field inside the trigger, not the trigger itself. */
const fromField = (e: SyntheticEvent): boolean => e.target !== e.currentTarget && e.target instanceof Element && e.target.closest(FIELD) !== null;

/** The text selected within `el`, or "" when none of it is. */
const selectionIn = (el: Element | null): string => {
  const sel = window.getSelection();
  if (el === null || sel === null || sel.isCollapsed) return "";
  for (let i = 0; i < sel.rangeCount; i++) if (sel.getRangeAt(i).intersectsNode(el)) return sel.toString();
  return "";
};

const opensMenu = (e: KeyboardEvent): boolean => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/**
 * Opens the menu from the keyboard as a right-click near the element's top left would. Chromium may also send its
 * own contextmenu for the key; that opens the same menu again, in place.
 */
const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
  if (e.defaultPrevented || !opensMenu(e) || fromField(e)) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + Math.min(r.height, 24) }));
};

/** A text field's right-click never reaches the trigger, so Chromium's own edit menu shows. */
const onContextMenuCapture = (e: SyntheticEvent) => {
  if (fromField(e)) e.stopPropagation();
};

/** The items, built only while the menu is open. */
function Items({ menu }: { menu: () => ReactNode }) {
  return menu();
}

export interface ContextMenuProps {
  /** The element the menu is on: one element that takes a ref and spreads its props (a row, a link, a button). */
  children: ReactElement;
  /** Its items: ContextMenuItem, ContextMenuCopy and ContextMenuSeparator. */
  menu: () => ReactNode;
  disabled?: boolean;
}

export function ContextMenu({ children, menu, disabled }: ContextMenuProps) {
  const trigger = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState("");
  return (
    <C.Root
      onOpenChange={(open) => {
        if (open) setSelected(selectionIn(trigger.current));
      }}
    >
      <C.Trigger ref={trigger} asChild disabled={disabled ?? false} onKeyDown={onKeyDown} onContextMenuCapture={onContextMenuCapture}>
        {children}
      </C.Trigger>
      <C.Portal>
        <C.Content className={s.surface} collisionPadding={8}>
          {selected !== "" ? (
            <>
              <ContextMenuCopy text={selected}>Copy selection</ContextMenuCopy>
              <ContextMenuSeparator />
            </>
          ) : null}
          <Items menu={menu} />
        </C.Content>
      </C.Portal>
    </C.Root>
  );
}

interface ItemExtras {
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
}

export function ContextMenuItem({ icon, hint, danger, className, children, ...rest }: ComponentProps<typeof C.Item> & ItemExtras) {
  return (
    <C.Item className={cx(s.item, danger && s.danger, className)} {...rest}>
      {icon}
      <span className={s.itemLabel} data-text="wrap">
        {children}
      </span>
      {hint ? <span className={s.itemHint}>{hint}</span> : null}
    </C.Item>
  );
}

/** An item that copies `text`; a refused copy says so. */
export function ContextMenuCopy({ text, ...rest }: Omit<ComponentProps<typeof ContextMenuItem>, "onSelect"> & { text: string }) {
  return (
    <ContextMenuItem
      {...rest}
      onSelect={() => {
        void copyText(text).then((ok) => {
          if (!ok) toast({ title: "Couldn’t copy", tone: "warning", key: "context-copy" });
        });
      }}
    />
  );
}

/** An item that opens more items beside it (React's tapbacks). */
export function ContextMenuSub({ label, icon, children }: { label: ReactNode; icon?: ReactNode; children: ReactNode }) {
  return (
    <C.Sub>
      <C.SubTrigger className={s.item}>
        {icon}
        <span className={s.itemLabel} data-text="wrap">
          {label}
        </span>
        <ChevronRight aria-hidden />
      </C.SubTrigger>
      <C.Portal>
        <C.SubContent className={s.surface} sideOffset={4} collisionPadding={8}>
          {children}
        </C.SubContent>
      </C.Portal>
    </C.Sub>
  );
}

export function ContextMenuSeparator() {
  return <C.Separator className={s.separator} />;
}
