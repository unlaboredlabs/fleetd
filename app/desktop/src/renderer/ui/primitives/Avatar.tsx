import type { CSSProperties } from "react";
import { initials, tintIndex } from "../../../shared/avatar";
import type { BotState } from "../../../shared/bot";
import { cx } from "../lib/cx";
import s from "./Avatar.module.css";
import { Bot } from "./Bot";

/** How many tints Avatar.module.css has. */
const TINTS = 10;

export interface AvatarProps {
  readonly name: string;
  /** Its side, in px. */
  readonly size?: number | undefined;
  /** Its picture (a data: URL), over the letters; none: the letters. */
  readonly src?: string | undefined;
  /** A bot's, in this state (Bot), shown when it has no picture, in place of the letters. */
  readonly bot?: BotState | undefined;
  readonly className?: string | undefined;
}

/**
 * A chat's avatar, a circle: its picture once it has one, else for a project its bot, else (a person) its initials on
 * a color picked from its name, the same as the phone's. Under 24 px it shows one letter. Decorative: the row or
 * title beside it says the name, and the letters are drawn by its CSS, so they are no part of that row's text.
 */
export function Avatar({ name, size = 20, src, bot, className }: AvatarProps) {
  const all = initials(name);
  const text = size < 24 ? (Array.from(all)[0] ?? all) : all;
  const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size * (text.length > 1 ? 0.38 : 0.46)) };
  const shown = src !== undefined ? "picture" : bot !== undefined ? "bot" : "letters";
  return (
    <span
      className={cx(s.avatar, shown === "bot" && s.bot, className)}
      style={style}
      aria-hidden
      data-tint={tintIndex(name, TINTS)}
      data-avatar={shown}
      data-letters={shown === "bot" ? "" : text}
    >
      {src !== undefined ? (
        <img className={s.picture} src={src} alt="" draggable={false} />
      ) : bot !== undefined ? (
        <Bot state={bot} size={size} />
      ) : null}
    </span>
  );
}
