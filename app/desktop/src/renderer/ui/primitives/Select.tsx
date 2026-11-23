import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Overlay.module.css";

export interface SelectOption<V extends string> {
  value: V;
  label: ReactNode;
  /** The trigger shows this text when the option's label is rich. */
  textValue?: string;
  disabled?: boolean;
  /** Its hover: why a disabled one can't be picked (on its label, which takes the pointer while the item doesn't). */
  title?: string;
  /** Words under the option, not part of it: why it and the disabled ones above it can't be picked, said once. */
  note?: ReactNode;
  /** The quiet word over a run of options that share it (a model's provider): said once, before the first. */
  group?: string;
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

/** Options in runs of one group each, in the order given: a run without a group is one with none. */
function runsOf<V extends string>(options: ReadonlyArray<SelectOption<V>>): { group: string | undefined; options: SelectOption<V>[] }[] {
  const runs: { group: string | undefined; options: SelectOption<V>[] }[] = [];
  for (const o of options) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.group === o.group) last.options.push(o);
    else runs.push({ group: o.group, options: [o] });
  }
  return runs;
}

/** A field-like picker over a short list, its options under their groups' words when they have them. Long lists
 * belong in the command palette, not here. */
export function Select<V extends string>(props: SelectProps<V>) {
  const { options } = props;
  const item = (o: SelectOption<V>) => (
    <Fragment key={o.value}>
      <S.Item value={o.value} className={s.item} {...(o.textValue ? { textValue: o.textValue } : {})} {...(o.disabled ? { disabled: true } : {})}>
        <span className={s.indicator}>
          <S.ItemIndicator>
            <Check />
          </S.ItemIndicator>
        </span>
        <span className={cx(s.itemLabel, o.title ? s.itemWhy : undefined)} data-text="wrap" {...(o.title ? { title: o.title } : {})}>
          <S.ItemText>{o.label}</S.ItemText>
        </span>
      </S.Item>
      {o.note === undefined ? null : <div className={s.note}>{o.note}</div>}
    </Fragment>
  );
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
            {runsOf(options).map((run, i, runs) =>
              run.group === undefined ? (
                // Words of no group after a group's (Add profile… after the profiles) stand apart from it, under a rule.
                <Fragment key={`none-${i}`}>
                  {runs[i - 1]?.group === undefined ? null : <S.Separator className={s.separator} />}
                  {run.options.map(item)}
                </Fragment>
              ) : (
                <S.Group key={`${run.group}-${i}`}>
                  <S.Label className={s.label}>{run.group}</S.Label>
                  {run.options.map(item)}
                </S.Group>
              ),
            )}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
