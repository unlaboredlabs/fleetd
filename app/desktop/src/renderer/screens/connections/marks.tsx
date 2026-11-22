// The marks in Connections' tiles: a named service's own (namedServers.ts), Tailscale's dots, and a custom MCP's
// initial. Each is drawn in the tile's text colour, the brand's own colour only where it has one that reads on both
// themes (Paper's blue), so the list stays calm.
import type { Named } from "../settings/namedServers";
import { initialOf } from "./model";
import c from "./connections.module.css";

export function Mark({ entry }: { entry: Named }) {
  return (
    <svg viewBox={entry.mark.viewBox} className={c.mark} data-mark={entry.id} aria-hidden>
      <path d={entry.mark.path} fill={entry.id === "paper" ? entry.mark.tint : "currentColor"} />
    </svg>
  );
}

/** Tailscale's nine dots: the middle row and the one below its centre full, the rest faint. */
const DOTS: ReadonlyArray<readonly [x: number, y: number, full: boolean]> = [
  [3, 3, false],
  [10, 3, false],
  [17, 3, false],
  [3, 10, true],
  [10, 10, true],
  [17, 10, true],
  [3, 17, false],
  [10, 17, true],
  [17, 17, false],
];

export function TailscaleMark() {
  return (
    <svg viewBox="0 0 20 20" className={c.mark} data-mark="tailscale" aria-hidden>
      {DOTS.map(([x, y, full]) => (
        <circle key={`${String(x)}-${String(y)}`} cx={x} cy={y} r={2.4} fill="currentColor" opacity={full ? 1 : 0.24} />
      ))}
    </svg>
  );
}

/** A custom MCP's initial, drawn by CSS from its attribute: a mark, not words, so the strip's overlap holds no text. */
export function Monogram({ name }: { name: string }) {
  return <span className={c.monogram} data-initial={initialOf(name)} aria-hidden />;
}
