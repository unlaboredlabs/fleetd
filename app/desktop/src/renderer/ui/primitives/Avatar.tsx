import type { CSSProperties } from "react";
import { initials, tintIndex } from "../../../shared/avatar";
import { cx } from "../lib/cx";
import s from "./Avatar.module.css";

/** How many tints Avatar.module.css has. */
const TINTS = 10;

export interface AvatarProps {
  readonly name: string;
  /** A Navi's letters sit on a soft gradient of its color, a project's on a wash of it, as on the phone. */
  readonly navi: boolean;
  /** Its side, in px. */
  readonly size?: number | undefined;
  /** Its picture (a data: URL), over the letters; none: the letters. */
  readonly src?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * A chat's avatar, a circle: its picture once it has one, else its initials on a color picked from its name, the same
 * as the phone's. Under 24 px it shows one letter. Decorative: the row or title beside it says the name, and the letters
 * are drawn by its CSS, so they are no part of that row's text.
 */
export function Avatar({ name, navi, size = 20, src, className }: AvatarProps) {
  const all = initials(name);
  const text = size < 24 ? (Array.from(all)[0] ?? all) : all;
  const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size * (text.length > 1 ? 0.38 : 0.46)) };
  return (
    <span
      className={cx(s.avatar, navi && s.navi, className)}
      style={style}
      aria-hidden
      data-tint={tintIndex(name, TINTS)}
      data-avatar={src === undefined ? "letters" : "picture"}
      data-letters={text}
    >
      {src === undefined ? null : <img className={s.picture} src={src} alt="" draggable={false} />}
    </span>
  );
}
