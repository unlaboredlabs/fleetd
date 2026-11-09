// A spring, as the motion language writes one (ui/DESIGN.md): stiffness, damping and mass, critically damped at
// damping = 2√(stiffness·mass), so it arrives fastest without passing its mark. Sampled into a CSS linear() curve over
// the time it takes to settle, as --ease-spring is, so the compositor runs it (WAAPI or CSS) and only transform and
// opacity change. The phone runs the same values on Reanimated's withSpring (app/mobile/src/ui/motion.ts).

export interface Spring {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

export interface SpringCurve {
  /** Until it settles: within 0.05% of its mark, and all but still. */
  readonly ms: number;
  /** linear(), 64 stops. */
  readonly ease: string;
}

const STOPS = 64;
const curves = new Map<string, SpringCurve>();

/** x'' = (-k (x - 1) - c x') / m from rest at 0, stepped at 4 kHz until it settles (3 s at most). */
export function springCurve({ stiffness: k, damping: c, mass: m }: Spring): SpringCurve {
  const key = `${String(k)}/${String(c)}/${String(m)}`;
  const known = curves.get(key);
  if (known !== undefined) return known;
  const dt = 1 / 4000;
  let x = 0;
  let v = 0;
  let t = 0;
  const xs: number[] = [];
  for (;;) {
    xs.push(x);
    v += ((-k * (x - 1) - c * v) / m) * dt;
    x += v * dt;
    t += dt;
    if ((Math.abs(1 - x) < 0.0005 && Math.abs(v) < 0.01) || t > 3) break;
  }
  const stops: string[] = [];
  for (let i = 0; i < STOPS - 1; i++) stops.push(String(+(xs[Math.round((i / (STOPS - 1)) * (xs.length - 1))] ?? 0).toFixed(4)));
  stops.push("1");
  const curve = { ms: Math.round(t * 1000), ease: `linear(${stops.join(", ")})` };
  curves.set(key, curve);
  return curve;
}
