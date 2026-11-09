// The bot (shared/bot.ts): one character for every project and Navi without a picture, as an SVG that fills its
// circle, whose motion says its state. Its paint comes light and dark as custom properties, which Bot.module.css picks
// from by the app's theme. It arrives settled in its state; ui/lib/botLife.ts then moves it on its springs, and a new
// `state` blends from wherever it is.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { BODY, frameOf, LIGHT, matrixAttr, newRig, PAINT, SMALL, type BotState, type Paint } from "../../../shared/bot";
import { bringToLife, type Living } from "../lib/botLife";
import s from "./Bot.module.css";

const KEYS: readonly (keyof Paint)[] = ["field", "hi", "body", "lo", "sheen", "sheenA", "shadow", "shadowA", "eye", "glowA"];
const PAINTED = Object.fromEntries(KEYS.flatMap((k) => [[`--l-${k}`, String(PAINT.light[k])], [`--d-${k}`, String(PAINT.dark[k])]])) as CSSProperties;
const v = (k: keyof Paint) => `var(--${k})`;

export function Bot({ state, size }: { state: BotState; size: number }) {
  // A gradient's url(#…) wants a plain id.
  const id = useId().replace(/[^\w-]/g, "");
  const ref = useRef<SVGSVGElement>(null);
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  // The rig lives as long as the bot at its size; its first frame is drawn here, settled in the state it arrives in.
  const at = useRef(state);
  const [rig] = useState(() => newRig(state, size, seed));
  const [first] = useState(() => frameOf(rig));
  const life = useRef<Living | null>(null);
  useEffect(() => {
    const svg = ref.current;
    if (svg === null) return;
    const l = bringToLife(svg, rig);
    life.current = l;
    return () => {
      l.release();
      life.current = null;
    };
  }, [rig]);
  useEffect(() => {
    if (at.current === state) return;
    at.current = state;
    life.current?.set(state);
  }, [state]);
  const glow = size >= SMALL;
  return (
    <svg ref={ref} className={s.bot} viewBox="0 0 100 100" width={size} height={size} style={PAINTED} data-bot={state} aria-hidden>
      <defs>
        <radialGradient id={`${id}b`} gradientUnits="userSpaceOnUse" cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r}>
          <stop offset="0" style={{ stopColor: v("hi") }} />
          <stop offset={LIGHT.mid} style={{ stopColor: v("body") }} />
          <stop offset="1" style={{ stopColor: v("lo") }} />
        </radialGradient>
        <radialGradient id={`${id}h`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
          <stop offset="0" style={{ stopColor: v("sheen"), stopOpacity: v("sheenA") }} />
          <stop offset="1" style={{ stopColor: v("sheen"), stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}s`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
          <stop offset="0" style={{ stopColor: v("shadow"), stopOpacity: v("shadowA") }} />
          <stop offset="1" style={{ stopColor: v("shadow"), stopOpacity: 0 }} />
        </radialGradient>
        {glow ? (
          <filter id={`${id}g`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        ) : null}
      </defs>
      <rect width="100" height="100" style={{ fill: v("field") }} />
      <ellipse data-part="shadow" rx="1" ry="1" fill={`url(#${id}s)`} transform={matrixAttr(first.shadow)} opacity={first.shadowOpacity} />
      <g data-part="body" transform={matrixAttr(first.body)}>
        <path d={BODY} fill={`url(#${id}b)`} />
        <ellipse data-part="sheen" rx="1" ry="1" fill={`url(#${id}h)`} transform={matrixAttr(first.sheen)} />
        {glow ? (
          <g data-part="glow" className={s.glow} filter={`url(#${id}g)`}>
            <path d={first.eyes[0]} />
            <path d={first.eyes[1]} />
          </g>
        ) : null}
        <g data-part="eyes" className={s.eyes}>
          <path d={first.eyes[0]} />
          <path d={first.eyes[1]} />
        </g>
      </g>
    </svg>
  );
}
