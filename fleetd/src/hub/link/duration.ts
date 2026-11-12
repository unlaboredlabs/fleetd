// How the link's and the outage's lines write a span of time (server.ts and outage/ use it).

/** `model::duration_text`: "45s", "10m46s", "2h05m". */
export function durationText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}
