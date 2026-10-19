import { Tabs as T } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./Misc.module.css";

export const Tabs = T.Root;

export function TabList({ className, ...rest }: ComponentProps<typeof T.List>) {
  return <T.List className={cx(s.tabList, className)} {...rest} />;
}

export function Tab({ count, className, children, ...rest }: ComponentProps<typeof T.Trigger> & { count?: ReactNode }) {
  return (
    <T.Trigger className={cx(s.tab, className)} {...rest}>
      {children}
      {count != null ? <span className={s.tabCount}>{count}</span> : null}
    </T.Trigger>
  );
}

export function TabPanel({ className, ...rest }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cx(s.tabPanel, className)} {...rest} />;
}
