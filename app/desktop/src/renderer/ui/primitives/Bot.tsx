// The bot (shared/bot.ts): one character for every project without a picture, the body alone, cropped to it
// (CROP) with no circle behind it, whose motion says its state. ui/lib/botLife.ts draws it on a canvas that reaches past
// its box (PAD), so its hops and slumps are never cut off, in its project's color for the app's theme (BOT_PAINT). It
// arrives settled in its state, drawn before its first paint; botLife then moves it on its springs, and a new `state`
// blends from wherever it is. A new `color` or `shape` (its body, BOT_BODIES) paints it at once.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { colorOf, drawnAt, LARGE, newRig, shapeOf, type BotState } from "../../../shared/bot";
import { bringToLife, type Living } from "../lib/botLife";
import s from "./Bot.module.css";

export function Bot({ state, size, color, shape }: { state: BotState; size: number; color?: string | undefined; shape?: string | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  // The rig lives as long as the bot, settled in the state it arrives in.
  const at = useRef(state);
  const painted = useRef(color);
  const shaped = useRef(shape);
  // Its size's rules go by the size its body is drawn at, its life on its own by its box.
  const [rig] = useState(() => newRig(state, drawnAt(size), seed, size >= LARGE));
  const life = useRef<Living | null>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const l = bringToLife(canvas, rig, size, painted.current, shaped.current);
    life.current = l;
    return () => {
      l.release();
      life.current = null;
    };
  }, [rig, size]);
  useEffect(() => {
    if (at.current === state) return;
    at.current = state;
    life.current?.set(state);
  }, [state]);
  useEffect(() => {
    if (painted.current === color && shaped.current === shape) return;
    painted.current = color;
    shaped.current = shape;
    life.current?.paint(color, shape);
  }, [color, shape]);
  return (
    <span className={s.bot} style={{ width: size, height: size }} data-bot={state} data-color={colorOf(color)} data-shape={shapeOf(shape)} aria-hidden>
      <canvas ref={ref} className={s.canvas} />
    </span>
  );
}
