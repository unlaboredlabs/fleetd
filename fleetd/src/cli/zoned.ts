// A wall clock in an IANA zone and back, from Intl alone: what the CLI's receipts and tables and the hub's nightly
// worktree sweep read their clock times with. Pure, so the package's hub-free modules may import it.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The parts of `ms` in `zone`. */
export function zoned(ms: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second" | "weekday", string>;
}

/** The UTC instant of a wall-clock time in `zone`. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number) => {
    const z = zoned(ms, zone);
    const wall = Date.UTC(Number(z.year), MONTHS.indexOf(z.month), Number(z.day), Number(z.hour), Number(z.minute));
    return wall - Math.floor(ms / 60_000) * 60_000;
  };
  // Earliest of the candidates either side of a change.
  const candidates = [guess - offsetAt(guess - 86_400_000), guess - offsetAt(guess + 86_400_000), guess - offsetAt(guess)];
  const exact = candidates.filter((c) => {
    const z = zoned(c, zone);
    return Number(z.day) === d && Number(z.hour) === h && Number(z.minute) === mi;
  });
  return exact.length > 0 ? Math.min(...exact) : guess - offsetAt(guess);
}
