// A built-in avatar (shared/botAvatar.ts): Ink, a soft-black being with light eyes on a pale tint of its color, as
// an SVG that fills its circle. Its colors come light and dark as custom properties, which BotFace.module.css picks
// from by the app's theme. Alive (ui/lib/botLife.ts) unless `still`: small ones take turns in their idle moments,
// large ones also breathe.
import { useEffect, useId, useMemo, useRef, type CSSProperties } from "react";
import { BODY, blinks, colorsOf, drawnFace, LARGE, LIGHT, matrixAttr, PLACE, pose, poseParts, STILL, type Colors } from "../../../shared/botAvatar";
import type { IconColor, IconFace } from "../../../shared/contracts";
import { bringToLife } from "../lib/botLife";
import s from "./BotFace.module.css";

const PAINT: readonly (keyof Colors)[] = ["field", "bodyHi", "body", "bodyLo", "hi", "hiA", "shadow", "shadowA", "eye"];

const paint = (color: IconColor): CSSProperties => {
  const light = colorsOf(color, false);
  const dark = colorsOf(color, true);
  return Object.fromEntries(PAINT.flatMap((k) => [[`--l-${k}`, String(light[k])], [`--d-${k}`, String(dark[k])]]));
};

const v = (k: keyof Colors) => `var(--${k})`;

export function BotFace({ face, color, size, still = false }: { face: IconFace; color: IconColor; size: number; still?: boolean }) {
  // A gradient's url(#…) wants a plain id.
  const id = useId().replace(/[^\w-]/g, "");
  const ref = useRef<SVGSVGElement>(null);
  const drawn = useMemo(() => drawnFace(face), [face]);
  const parts = useMemo(() => poseParts(drawn), [drawn]);
  const rest = useMemo(() => pose(parts, STILL).map(matrixAttr), [parts]);
  useEffect(() => {
    const svg = ref.current;
    if (still || svg === null) return;
    return bringToLife({ svg, parts, canBlink: blinks(face), large: size >= LARGE });
  }, [still, parts, face, size]);
  return (
    <svg ref={ref} className={s.face} viewBox="0 0 100 100" width={size} height={size} style={paint(color)} data-icon={`${face}-${color}`} aria-hidden>
      <defs>
        <radialGradient id={`${id}b`} gradientUnits="userSpaceOnUse" cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r}>
          <stop offset="0" style={{ stopColor: v("bodyHi") }} />
          <stop offset={LIGHT.mid} style={{ stopColor: v("body") }} />
          <stop offset="1" style={{ stopColor: v("bodyLo") }} />
        </radialGradient>
        <radialGradient id={`${id}h`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
          <stop offset="0" style={{ stopColor: v("hi"), stopOpacity: v("hiA") }} />
          <stop offset="1" style={{ stopColor: v("hi"), stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}s`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
          <stop offset="0" style={{ stopColor: v("shadow"), stopOpacity: v("shadowA") }} />
          <stop offset="1" style={{ stopColor: v("shadow"), stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <rect width="100" height="100" style={{ fill: v("field") }} />
      <g transform={`matrix(${PLACE.scale} 0 0 ${PLACE.scale} ${PLACE.x} ${PLACE.y})`}>
        <ellipse data-pose="1" rx="1" ry="1" fill={`url(#${id}s)`} transform={rest[1]} />
        <g data-pose="0" transform={rest[0]}>
          <path d={BODY} fill={`url(#${id}b)`} />
          <ellipse data-pose="2" rx="1" ry="1" fill={`url(#${id}h)`} transform={rest[2]} />
          {drawn.map((d, i) => (
            <g key={i} data-pose={3 + i * 2} transform={rest[3 + i * 2]}>
              <g data-pose={4 + i * 2} transform={rest[4 + i * 2]} style={{ fill: v("eye") }}>
                {d.ellipse === undefined ? <path d={d.path} /> : <ellipse rx={d.ellipse[0]} ry={d.ellipse[1]} transform={`rotate(${d.ellipse[2]})`} />}
              </g>
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
