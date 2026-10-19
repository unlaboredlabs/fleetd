import { Checkbox as CheckboxPrimitive, RadioGroup as RadioPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { Kbd } from "./Button";
import s from "./Field.module.css";

interface FieldIds {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldIds | null>(null);

/** A labelled control: the label, the control, then a description or an error. Wires ids and aria for the control. */
export function Field(props: {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const descId = props.description ? `${id}-desc` : undefined;
  const errId = props.error ? `${id}-err` : undefined;
  const describedBy = [descId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(props.error) }}>
      <div className={cx(s.field, props.className)}>
        <label htmlFor={id} className={s.label} data-text="wrap">
          {props.label}
        </label>
        {props.children}
        {props.description ? (
          <p id={descId} className={s.description} data-text="wrap">
            {props.description}
          </p>
        ) : null}
        {props.error ? (
          <p id={errId} className={s.error} data-text="wrap" role="alert">
            {props.error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

function useFieldProps(props: { id?: string | undefined; "aria-invalid"?: ComponentProps<"input">["aria-invalid"] }) {
  const field = useContext(FieldContext);
  return {
    id: props.id ?? field?.id,
    "aria-describedby": field?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid || undefined),
  };
}

export interface InputProps extends ComponentProps<"input"> {
  /** Machine text (paths, commands, ids typed by the user). */
  mono?: boolean;
}

export function Input({ className, mono, ...rest }: InputProps) {
  return <input className={cx(s.input, mono && s.mono, className)} spellCheck={false} {...useFieldProps(rest)} {...rest} />;
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  mono?: boolean;
  /** Grows with its content from `minRows` to `maxRows`, then scrolls. */
  minRows?: number;
  maxRows?: number;
}

export function Textarea({ className, mono, minRows = 2, maxRows = 12, style, ...rest }: TextareaProps) {
  const line = mono ? 18 : 20;
  // 4 px padding top and bottom plus the 1 px border on each side.
  const chrome = 10;
  return (
    <textarea
      className={cx(s.textarea, mono && s.mono, className)}
      style={{ minHeight: minRows * line + chrome, maxHeight: maxRows * line + chrome, ...style }}
      {...useFieldProps(rest)}
      {...rest}
    />
  );
}

/** A label and an optional line under it, beside a checkbox, radio or switch. */
function CheckText(props: { label: ReactNode; description?: ReactNode | undefined; disabled?: boolean | undefined }) {
  return (
    <span className={cx(s.checkText, props.disabled && s.disabledText)} data-text="wrap">
      <span>{props.label}</span>
      {props.description ? <span className={s.description}>{props.description}</span> : null}
    </span>
  );
}

export interface CheckboxProps extends Omit<ComponentProps<typeof CheckboxPrimitive.Root>, "children"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, id, ...rest }: CheckboxProps) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <label className={cx(s.check, className)} htmlFor={cid}>
      <CheckboxPrimitive.Root id={cid} className={s.checkbox} {...rest}>
        <CheckboxPrimitive.Indicator>
          {rest.checked === "indeterminate" ? <Minus strokeWidth={3} /> : <Check strokeWidth={3} />}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <CheckText label={label} description={description} disabled={rest.disabled} />
    </label>
  );
}

export function Switch({
  label,
  description,
  className,
  id,
  ...rest
}: Omit<ComponentProps<typeof SwitchPrimitive.Root>, "children"> & { label: ReactNode; description?: ReactNode }) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <label className={cx(s.check, className)} htmlFor={cid}>
      <SwitchPrimitive.Root id={cid} className={s.switch} {...rest}>
        <SwitchPrimitive.Thumb className={s.thumb} />
      </SwitchPrimitive.Root>
      <CheckText label={label} description={description} disabled={rest.disabled} />
    </label>
  );
}

export function RadioGroup({ className, ...rest }: ComponentProps<typeof RadioPrimitive.Root>) {
  return <RadioPrimitive.Root className={cx(s.radioGroup, className)} {...rest} />;
}

export function Radio({
  label,
  description,
  className,
  id,
  ...rest
}: Omit<ComponentProps<typeof RadioPrimitive.Item>, "children"> & { label: ReactNode; description?: ReactNode }) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <label className={cx(s.check, className)} htmlFor={cid}>
      <RadioPrimitive.Item id={cid} className={s.radio} {...rest}>
        <RadioPrimitive.Indicator className={s.radioDot} />
      </RadioPrimitive.Item>
      <CheckText label={label} description={description} disabled={rest.disabled} />
    </label>
  );
}

export interface RadioCardProps extends Omit<ComponentProps<typeof RadioPrimitive.Item>, "children"> {
  /** A short human label for the choice. Never a key or slug. */
  label: ReactNode;
  /** One line: what happens if you pick this. */
  detail?: ReactNode;
  /** A tag set inside the card next to the label ("Recommended"). */
  tag?: ReactNode;
  /** Why it is tagged (the lead's one-line reason). */
  reason?: ReactNode;
  /** The key that picks it ("1"); shown as a hint, the caller binds it. */
  shortcut?: string;
}

/**
 * A full-width, clickable choice card. Everything inside wraps; nothing truncates. Lives in a <RadioGroup>, which
 * gives arrow-key movement; the caller adds number keys and Enter where the screen wants them.
 */
export function RadioCard({ label, detail, tag, reason, shortcut, className, ...rest }: RadioCardProps) {
  return (
    <RadioPrimitive.Item className={cx(s.card, className)} {...rest}>
      <span className={s.radio} aria-hidden>
        <RadioPrimitive.Indicator className={s.radioDot} />
      </span>
      <span className={s.cardBody} data-text="wrap">
        <span className={s.cardHead}>
          <span className={s.cardLabel}>{label}</span>
          {tag ? <span className={s.cardTag}>{tag}</span> : null}
        </span>
        {reason ? <span className={s.cardReason}>{reason}</span> : null}
        {detail ? <span className={s.cardDetail}>{detail}</span> : null}
      </span>
      {shortcut ? (
        <span className={s.cardKey}>
          <Kbd>{shortcut}</Kbd>
        </span>
      ) : null}
    </RadioPrimitive.Item>
  );
}
