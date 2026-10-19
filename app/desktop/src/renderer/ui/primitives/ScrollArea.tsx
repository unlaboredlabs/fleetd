import { ScrollArea as S } from "radix-ui";
import type { ReactNode, Ref } from "react";
import { cx } from "../lib/cx";
import s from "./Misc.module.css";

export interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  /** The scrolling element, for virtualizers and scroll-to. */
  viewportRef?: Ref<HTMLDivElement>;
  horizontal?: boolean;
}

/** A region that scrolls with thin overlay scrollbars that appear on hover and while scrolling. */
export function ScrollArea({ children, className, viewportRef, horizontal }: ScrollAreaProps) {
  return (
    <S.Root className={cx(s.scrollRoot, className)} type="hover" scrollHideDelay={600}>
      <S.Viewport ref={viewportRef} className={s.scrollViewport}>
        {children}
      </S.Viewport>
      <S.Scrollbar orientation="vertical" className={s.scrollbar}>
        <S.Thumb className={s.scrollThumb} />
      </S.Scrollbar>
      {horizontal ? (
        <S.Scrollbar orientation="horizontal" className={s.scrollbar}>
          <S.Thumb className={s.scrollThumb} />
        </S.Scrollbar>
      ) : null}
    </S.Root>
  );
}
