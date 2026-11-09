// The bot (shared/bot.ts): one character for every project and Navi without a picture, as an SVG of the body alone,
// cropped to it (CROP) with no circle behind it, whose motion says its state. Its hops and slumps reach past its box, so
// it overflows it. Its paint comes light and dark as custom properties, which Bot.module.css picks from by the app's
// theme. It arrives settled in its state; ui/lib/botLife.ts then moves it on its springs, and a new `state` blends from
// wherever it is.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { BODY, drawnAt, frameOf, LARGE, matrixAttr, newRig, PEBBLE, VIEW_BOX, type BotState, type Paint } from "../../../shared/bot";
import { bringToLife, type Living } from "../lib/botLife";
import s from "./Bot.module.css";

const KEYS: readonly (keyof Paint)[] = ["body", "eye", "glowA"];
const PAINTED = Object.fromEntries(KEYS.flatMap((k) => [[`--l-${k}`, String(PEBBLE.light[k])], [`--d-${k}`, String(PEBBLE.dark[k])]])) as CSSProperties;
const v = (k: keyof Paint) => `var(--${k})`;

export function Bot({ state, size }: { state: BotState; size: number }) {
  // A gradient's url(#…) wants a plain id.
  const id = useId().replace(/[^\w-]/g, "");
  const ref = useRef<SVGSVGElement>(null);
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  // The rig lives as long as the bot at its size; its first frame is drawn here, settled in the state it arrives in.
  const at = useRef(state);
  // Its size's rules go by the size its body is drawn at, its life on its own by its box.
  const [rig] = useState(() => newRig(state, drawnAt(size), seed, size >= LARGE));
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
  const glow = rig.glow;
  return (
    <svg ref={ref} className={s.bot} viewBox={VIEW_BOX} width={size} height={size} style={PAINTED} data-bot={state} aria-hidden>
      {glow ? (
        <defs>
          <filter id={`${id}g`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        </defs>
      ) : null}
      <g data-part="body" transform={matrixAttr(first.body)}>
        <path d={BODY} style={{ fill: v("body") }} />
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
