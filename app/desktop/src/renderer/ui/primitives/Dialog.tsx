import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import s from "./Overlay.module.css";

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens it, if the dialog owns its trigger. */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned; the primary action last. */
  footer?: ReactNode;
  /** `sheet` slides in from the right edge and fills the height (Add project, details). */
  kind?: "dialog" | "sheet";
  wide?: boolean;
}

/** A modal dialog or side sheet: title, optional description, a scrolling body, a footer. Esc and the X close it. */
export function Dialog(props: DialogProps) {
  const { kind = "dialog" } = props;
  return (
    <D.Root {...(props.open !== undefined ? { open: props.open } : {})} {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}>
      {props.trigger ? <D.Trigger asChild>{props.trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className={s.backdrop} />
        <D.Content
          className={cx(kind === "sheet" ? s.sheet : s.dialog, props.wide && kind === "dialog" && s.wide)}
          {...(props.description ? {} : { "aria-describedby": undefined })}
        >
          <div className={s.dialogHead}>
            <div className={s.dialogTitles}>
              <D.Title className={s.dialogTitle} data-text="wrap">
                {props.title}
              </D.Title>
              {props.description ? (
                <D.Description className={s.dialogDescription} data-text="wrap">
                  {props.description}
                </D.Description>
              ) : null}
            </div>
            <D.Close asChild>
              <Button variant="quiet" iconOnly aria-label="Close">
                <X />
              </Button>
            </D.Close>
          </div>
          {props.children ? <div className={s.dialogBody}>{props.children}</div> : null}
          {props.footer ? <div className={s.dialogFooter}>{props.footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** A dialog that slides in from the right edge. */
export function Sheet(props: Omit<DialogProps, "kind" | "wide">) {
  return <Dialog {...props} kind="sheet" />;
}
