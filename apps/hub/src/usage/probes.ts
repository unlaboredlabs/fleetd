// The probe counter: how many direct usage or reset-credit calls a T3 made, counted from its trace file. fleetd
// configures T3 so it never makes one (no stored OAuth credentials, no cliproxy usage source), so this must read 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ProbeCounter } from "@fleetd/contracts";
import * as Effect from "effect/Effect";

/**
 * A line that shows a call out: the URLs of the `oauth/usage` probe and of Claude's and Codex's reset-credit calls,
 * or a span of T3's CLIProxyAPI usage source, which only runs when it calls the proxy. A span like
 * `readClaudeResetCredits` alone does not count: it returns early without a stored token.
 */
export const PROBE_LINE = /api\/oauth\/usage|reset_rate_limits|rate-limit-reset-credits|"name":"CliproxyApi\./u;

const TRACE_FILE = /^server\.trace\.ndjson(?:\.\d+)?$/u;

const cache = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly count: number }>();

const countFile = (file: string) =>
  Effect.tryPromise(async () => {
    const stat = await fs.promises.stat(file);
    const hit = cache.get(file);
    if (hit !== undefined && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.count;
    let count = 0;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) if (PROBE_LINE.test(line)) count++;
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, count });
    return count;
  });

const realish = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const isWithin = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const notObservable = (reason: string): ProbeCounter => ({ observable: false, reason });

/**
 * Counts probe lines across `server.trace.ndjson` and its rotations in `logsDir`. Refuses anything under the live T3
 * home (`~/.t3`), which fleetd never reads.
 */
export const countProbes = (logsDir: string, userHome: string = os.homedir()): Effect.Effect<ProbeCounter> =>
  Effect.gen(function* () {
    const t3Home = path.join(userHome, ".t3");
    const live = notObservable("T3's logs are in the live T3 home (~/.t3), which fleetd never reads");
    if (!path.isAbsolute(logsDir)) return notObservable(`T3 reported a relative logs directory, ${logsDir}`);
    // The plain path first, so nothing under ~/.t3 is touched; then through symlinks.
    if (isWithin(t3Home, path.resolve(logsDir))) return live;
    const dir = realish(logsDir);
    if (isWithin(realish(t3Home), dir)) return live;
    const names = yield* Effect.tryPromise(() => fs.promises.readdir(dir)).pipe(Effect.orElseSucceed(() => undefined));
    const traces = names?.filter((n) => TRACE_FILE.test(n)) ?? [];
    if (traces.length === 0) return notObservable(`no T3 trace file in ${logsDir}`);
    let count = 0;
    for (const name of traces) {
      const n = yield* countFile(path.join(dir, name)).pipe(Effect.option);
      if (n._tag === "None") return notObservable(`T3's trace file ${name} in ${logsDir} is not readable`);
      count += n.value;
    }
    return { observable: true, count, source: logsDir };
  });
