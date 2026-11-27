// The dev servers an agent's share link keeps past its session (decision product.share-link-outlives-agent), without
// a file system or a process: what the workspace tells a machine (`share_kept`) and what the session host reads
// (`<host dir>.kept`). Imported by the cloud at its pin (`fleetd/shared/share_kept`), which writes the file into a box
// whose session it keeps for a link.

/** The node takes `share_kept`: it keeps the processes listening on an agent's shared port past its session. */
export const CAP_SHARE_KEPT = "share_kept";

/** One open link an agent made on the machine: its session (`thread`), its port, and when it ends. `share_kept`'s
 * `links` lists every one of the machine's, each time any of them changes and as the machine links: a port no longer
 * listed is no longer kept, and its processes are stopped. */
export type KeptLink = { thread: string; port: number; untilMs: number };

/** The process group found listening on a kept port: its listener by pid and start time (Linux clock ticks; none on
 * macOS), and its group. */
export type KeptGroup = { pid: number; start?: number; pgid: number };

/** One port of `<host dir>.kept`: spared until `untilMs`. With no `group`, a sweep looks up what listens on the port then,
 * and spares it only when it carries the session's own marker (Linux). */
export type KeptPort = { port: number; untilMs: number; group?: KeptGroup };

/** Where a session's kept ports are: beside its host's dir (`<home>/hosts/<session>`; in a box, `<box dir>/guest/<session>`). */
export const keptFile = (hostDir: string) => `${hostDir}.kept`;

/** `<host dir>.kept`'s text. */
export const keptText = (ports: KeptPort[]) => `${JSON.stringify({ ports })}\n`;

const int = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;

/** The ports `<host dir>.kept`'s text names; nothing for text that isn't one. */
export function readKept(text: string): KeptPort[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const ports = (parsed as { ports?: unknown })?.ports;
  if (!Array.isArray(ports)) return [];
  return ports.flatMap((p: Partial<KeptPort> | null): KeptPort[] => {
    if (!p || !int(p.port, 1) || (p.port as number) > 65535 || typeof p.untilMs !== "number") return [];
    const g = p.group;
    const group = g && int(g.pid, 2) && int(g.pgid, 2) && (g.start === undefined || int(g.start, 0)) ? { pid: g.pid, pgid: g.pgid, ...(g.start !== undefined ? { start: g.start } : {}) } : undefined;
    return [{ port: p.port as number, untilMs: p.untilMs, ...(group ? { group } : {}) }];
  });
}

/** `share_kept`'s links, checked: a session id fit for a file name, a TCP port, an end. */
export function keptLinks(links: unknown): KeptLink[] {
  if (!Array.isArray(links)) return [];
  return links.flatMap((l: Partial<KeptLink> | null): KeptLink[] =>
    l && typeof l.thread === "string" && /^[\w-][\w.-]*$/.test(l.thread) && int(l.port, 1) && (l.port as number) <= 65535 && typeof l.untilMs === "number"
      ? [{ thread: l.thread, port: l.port as number, untilMs: l.untilMs }]
      : [],
  );
}
