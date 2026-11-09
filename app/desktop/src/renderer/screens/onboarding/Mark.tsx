import { useId } from "react";
import { BODY, frameOf, newRig } from "../../../shared/bot";
import { cx } from "../../ui";
import s from "./mark.module.css";

/** Pebble at rest, its eyes as the bot draws them. */
const EYES = frameOf(newRig("idle", 200, 0)).eyes;

/** The app's icon (Peek: Pebble rising from the tile's bottom edge, app/icon/mac.svg) in the theme's colours, drawn
 * here so a welcome has the product's face without loading an image. */
export function Mark({ className }: { className?: string | undefined }) {
  const clip = useId();
  return (
    <svg className={cx(s.mark, className)} viewBox="100 100 824 824" aria-hidden>
      <clipPath id={clip}>
        <rect x="100" y="100" width="824" height="824" rx="185" />
      </clipPath>
      <rect className={s.markTile} x="100" y="100" width="824" height="824" rx="185" />
      <g clipPath={`url(#${clip})`}>
        <g transform="translate(5.05 111.91) scale(10.139)">
          <path className={s.markBody} d={BODY} />
          <path className={s.markTile} d={EYES[0] + EYES[1]} />
        </g>
      </g>
    </svg>
  );
}
