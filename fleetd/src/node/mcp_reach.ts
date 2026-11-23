// An agent's MCP servers that are reached by address (`http`, `sse`), looked at before its claude starts. claude waits
// for each server at its start, up to MCP_TIMEOUT (30 s) for one that never answers, before its first request: a lead
// whose team's server was down sat 30 s on every start (W818, fleetd's cloud, 2026-11-23). A server that doesn't answer
// within MCP_REACH_MS is left out of that start's `--mcp-config`, and the agent is told once, ahead of its next message,
// to mention it to the person in one plain line when they next write. A server that answers at all, whatever its HTTP
// status, is kept: only one that can't be reached is left out. One reached through `fleetd mcp-relay` (stdio) is never
// looked at here: its relay answers.
//
// The look itself is the caller's: the node's from where its claude runs (`reaches`), fleetd's cloud's from inside the
// box its claude runs in. Box side: imported by fleetd's cloud through the package (`fleetd/box/mcp_reach`). Lighter than
// ./actions/mcp_probe.ts (`mcp_test`), which starts and lists a server: here only whether its address answers.

/** How long a server has to answer before its start goes on without it. */
export const MCP_REACH_MS = 3_000;

type Entries = Record<string, unknown>;

/** The servers of an `mcpServers` map reached by address: their names and addresses. */
export function addressed(servers: Entries): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const e = entry as { type?: unknown; url?: unknown };
    if ((e.type === "http" || e.type === "sse") && typeof e.url === "string" && e.url !== "") out.push({ name, url: e.url });
  }
  return out;
}

/** Whether `url` answers from here within `ms`: any HTTP answer does; a refusal, no route or no answer in time doesn't.
 * Its body is never read (an MCP server's GET may be a stream that doesn't end). */
export async function reaches(url: string, ms = MCP_REACH_MS): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(ms), headers: { accept: "application/json, text/event-stream" } });
    await r.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** The names of `servers`' addressed servers that `look` finds unanswered, all looked at side by side. */
export async function unanswered(servers: Entries, look: (url: string) => Promise<boolean> = (u) => reaches(u)): Promise<string[]> {
  const all = addressed(servers);
  const seen = await Promise.all(all.map(async (s) => ((await look(s.url).catch(() => false)) ? undefined : s.name)));
  return seen.filter((n): n is string => n !== undefined);
}

/** `servers` without `names`. */
export function without(servers: Entries, names: readonly string[]): Entries {
  return Object.fromEntries(Object.entries(servers).filter(([n]) => !names.includes(n)));
}

const quoted = (names: readonly string[]) => names.map((n) => `“${n}”`).join(names.length === 2 ? " and " : ", ");

/** What a lead's chat says, in fleetd's own words, when its start left servers out: one plain line, once per start. */
export function skippedLine(names: readonly string[]): string {
  const one = names.length === 1;
  return `The MCP server${one ? "" : "s"} ${quoted(names)} didn't answer, so ${one ? "its" : "their"} tools are off until the next start.`;
}

/** What a lead's chat says when servers the previous start left out answer again. */
export function backLine(names: readonly string[]): string {
  const one = names.length === 1;
  return `The MCP server${one ? "" : "s"} ${quoted(names)} answer${one ? "s" : ""} again: ${one ? "its" : "their"} tools are back.`;
}

/**
 * What changed from the servers the previous start left out, `before`, to this start's, `now`: the ones newly left out
 * (`down`), and the ones left out before that this start looked at and that answered (`back`). A server that stays down
 * changes nothing; one no longer looked at (removed, renamed, now stdio) is never back, and once re-added and still down
 * it is newly down again.
 */
export function startChange(before: readonly string[], now: readonly string[], looked: readonly string[]): { down: string[]; back: string[] } {
  return { down: now.filter((n) => !before.includes(n)), back: before.filter((n) => looked.includes(n) && !now.includes(n)) };
}

/** What the agent hears ahead of its next message when servers were left out of its start: the person hears it from
 * the agent once, in plain words, inside its reply to them, never as a message of its own. */
export function skippedNote(names: readonly string[], ms = MCP_REACH_MS): string {
  const one = names.length === 1;
  return (
    `[fleetd: this session started without the MCP server${one ? "" : "s"} ${quoted(names)}: ${one ? "it" : "they"} didn't answer within ${ms / 1000} s, ` +
    `so ${one ? "its" : "their"} tools aren't available until a later start reaches ${one ? "it" : "them"}. ` +
    `Mention this once, in one plain line, inside your reply the next time the person writes (if this message isn't the person's, ` +
    `keep it for their next one). Never send it as a message of its own, and don't repeat it after that.]`
  );
}
