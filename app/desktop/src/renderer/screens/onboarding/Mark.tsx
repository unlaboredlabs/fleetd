import { cx } from "../../ui";
import s from "./mark.module.css";

/** The app's icon in the theme's colours, drawn here so a welcome has the product's face without loading an image. */
export function Mark({ className }: { className?: string | undefined }) {
  return (
    <svg className={cx(s.mark, className)} viewBox="100 100 824 824" aria-hidden>
      <rect className={s.markTile} x="100" y="100" width="824" height="824" rx="185" />
      <g className={s.markChevrons} fill="none" strokeWidth="72" strokeLinecap="round" strokeLinejoin="round">
        <path d="M255 362 405 512 255 662" opacity=".4" />
        <path d="M437 362 587 512 437 662" opacity=".7" />
        <path d="M619 362 769 512 619 662" />
      </g>
    </svg>
  );
}
