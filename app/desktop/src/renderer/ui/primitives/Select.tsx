import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

export interface SelectOption<V extends string> {
  value: V;
  label: ReactNode;
  /** The trigger shows this text when the option's label is rich. */
  textValue?: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: ReadonlyArray<SelectOption<V>>;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string | undefined;
}

/** A field-like picker over a short list. Long lists belong in the command palette, not here. */
export function Select<V extends string>(props: SelectProps<V>) {
  const { options } = props;
  return (
    <S.Root
      {...(props.value !== undefined ? { value: props.value } : {})}
      onValueChange={(v) => {
        const hit = options.find((o) => o.value === v);
        if (hit) props.onValueChange(hit.value);
      }}
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
    >
      <S.Trigger
        className={cx(s.trigger, props.className)}
        {...(props.id ? { id: props.id } : {})}
        {...(props["aria-label"] ? { "aria-label": props["aria-label"] } : {})}
      >
        <span className={s.triggerValue} data-text="truncate">
          <S.Value placeholder={props.placeholder ?? "Choose…"} />
        </span>
        <S.Icon asChild>
          <ChevronDown />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content className={cx(s.surface, s.selectContent)} position="popper" sideOffset={4} collisionPadding={8}>
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                className={s.item}
                {...(o.textValue ? { textValue: o.textValue } : {})}
                {...(o.disabled ? { disabled: true } : {})}
              >
                <span className={s.indicator}>
                  <S.ItemIndicator>
                    <Check />
                  </S.ItemIndicator>
                </span>
                <span className={s.itemLabel} data-text="wrap">
                  <S.ItemText>{o.label}</S.ItemText>
                </span>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
