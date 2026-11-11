import type { ReactNode } from "react";
import { Text } from "../../ui";
import s from "./addMachine.module.css";

/** A view's quiet label and line, as a Settings section's; `aside` at its right end (the ways in's Close). */
export function Head(props: { title: string; line?: ReactNode; aside?: ReactNode }) {
  return (
    <div className={s.top}>
      <div className={s.head}>
        <Text as="h2" size="sm" strong tone="quiet" className={s.label}>
          {props.title}
        </Text>
        {props.line === undefined ? null : (
          <Text size="sm" tone="quiet">
            {props.line}
          </Text>
        )}
      </div>
      {props.aside}
    </div>
  );
}
