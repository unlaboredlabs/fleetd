// `fleetd mac-job <log> <end>`: one `mac run` job on the agents' Mac, held by a process of its own that outlives the
// node, so an update's restart of the node never ends an agent's build (18:02–18:46 UTC on Nov 26 each update ended
// every job on the Mac). The node starts it in a session of its own (host.ts `start`) with the job's environment, and
// sends its command line and the values to mask on stdin, never on disk. It copies what the job says into the log,
// masked and capped, and writes the job's exit code to `end` as the job ends; the node reads both, this node or the
// next one (host.ts `adoptJobs`). Imports only what it uses: one runs per job.
import { closeSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import type { MacEnv } from "./protocol.ts";

/** What the node sends on stdin. */
export type JobSpec = { argv: string[]; cwd: string; named: MacEnv[]; logMax: number };

/** Masks the values the agent sent along with its job in what the job logs. */
export function masker(named: MacEnv[]): (text: string) => string {
  const values = named.map((e) => [e.value, `***${e.name}***`] as const).filter(([v]) => v.length >= 4).sort((a, b) => b[0].length - a[0].length);
  return (text) => values.reduce((t, [v, shown]) => t.split(v).join(shown), text);
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/** The job's exit code as a shell gives it: a signal's is 128 and its number. */
export const exitOf = (code: number | null, signal: string | null | undefined) => (signal ? 128 + (SIGNALS[signal] ?? 0) : (code ?? 1));

/**
 * A job's output into `out`, up to `max` bytes: past it the output is dropped and the job runs on, its end still
 * kept. The line saying so goes in once output comes past the cap, also when a piece ended right at it (1 MB is 16
 * pipe reads of 64 KB: on Nov 26 such a log stopped without it).
 */
export function capped(max: number, out: (bytes: Uint8Array) => void): (text: string) => void {
  let written = 0;
  let full = false;
  return (text) => {
    if (full || text === "") return;
    const bytes = Buffer.from(text);
    const room = max - written;
    if (bytes.length <= room) {
      written += bytes.length;
      return out(bytes);
    }
    full = true;
    out(Buffer.concat([bytes.subarray(0, room), Buffer.from(`\n[fleetd: this log stops here, at ${Math.round(max / 2 ** 20)} MB; the job runs on]\n`)]));
  };
}

export async function main(argv: string[]): Promise<number> {
  const [log, end] = argv;
  if (!log || !end) {
    process.stderr.write("usage: fleetd mac-job <log> <end> (the agents' Mac's node starts it)\n");
    return 64;
  }
  const spec = JSON.parse(await new Response(Bun.stdin.stream()).text()) as JobSpec;
  // `mac kill` signals the job's whole group, this process too: the job takes the signal, and this stays to keep its end.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => {});
  const fd = openSync(log, "a");
  const mask = masker(spec.named);
  const write = capped(spec.logMax, (bytes) => {
    try {
      writeSync(fd, bytes);
    } catch {
      // The disk is full: what the job says now is lost, never the job.
    }
  });
  let code: number;
  try {
    const child = Bun.spawn(spec.argv, { cwd: spec.cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const copy = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) write(mask(decoder.decode(chunk, { stream: true })));
    };
    await Promise.all([copy(child.stdout), copy(child.stderr)]);
    code = exitOf(await child.exited, child.signalCode === null ? null : String(child.signalCode));
  } catch (e) {
    write(`fleetd: the command didn't start on the Mac: ${e instanceof Error ? e.message : String(e)}\n`);
    code = 127;
  }
  closeSync(fd);
  writeFileSync(`${end}.tmp`, String(code));
  renameSync(`${end}.tmp`, end);
  return 0;
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
