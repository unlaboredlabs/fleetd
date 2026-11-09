// One live claude process (crates/fleetd/src/node/runner/claude/session.rs): it owns the child, pumps its stdout and
// stderr through the StreamMapper, writes its stdin, and ends it with the kill ladder.
//
// Kill ladder (Shutdown{grace}):
// 1. If a run is active, write an interrupt `control_request` (claude stops the tool and ends the run with `aborted_*`).
//    Then close stdin: claude exits once it has no run left.
// 2. After `grace`: sweep the session's processes, then SIGTERM claude's process group. claude kills its own tool
//    children on SIGTERM and exits 143.
// 3. After TERM_GRACE_MS more: sweep again, SIGKILL every swept process group and pid, then claude's group.
// 4. Whenever claude exits, for any reason: sweep once more and SIGKILL whatever is left, read the rest of stdout, reap
//    adopted orphans, and only then emit Exited.
// 5. After RESWEEP_AFTER_MS: sweep by the marker again and SIGKILL what it finds, once more if it found anything. A tool
//    mid-`exec` at the first sweep had an empty `/proc/<pid>/environ`, so its marker could not be read.
//
// Latency: each stdout chunk is mapped as soon as it is read; the text deltas of one message read in one chunk go out
// as one Delta, and a delta is never held back waiting for more.
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import { nowIso } from "../../util.ts";
import { dedupe, signal, type Proc } from "../procs.ts";
import { graceMs, type ExitInfo, type RunnerEvent, type SessionCommand } from "./events.ts";
import { classify } from "./failure.ts";
import { StreamMapper, systemNow } from "./mapper.ts";
import { decodeLine, type Input } from "./protocol.ts";
import { reap, SESSION_MARKER, sweep, sweepMarked, track, untrack } from "./reaper.ts";

/** From SIGTERM to SIGKILL. */
export const TERM_GRACE_MS = 5_000;
/** After claude exited, how long the rest of stdout may take (a descendant that held the pipe is killed by then). */
const DRAIN_MS = 2_000;
/** How long to wait for killed orphans to be reaped. */
const REAP_MS = 5_000;
/** From the sweep at the exit to the next one, and between the later ones. */
const RESWEEP_AFTER_MS = 1_000;
/** Sweeps after the one at the exit, at most: each after the first only when the one before found something. */
const RESWEEPS = 2;

type Phase = "running" | "closing" | "terming" | "killed";
const warn = (message: string) => process.stderr.write(`${nowIso()} WARN ${message}\n`);

/** Splits a byte stream into lines (without `\n` and trailing `\r`s), decoded lossily as UTF-8. */
class Lines {
  #rest: Buffer | undefined;
  #decoder = new TextDecoder();
  push(chunk: Buffer): string[] {
    let buf = this.#rest ? Buffer.concat([this.#rest, chunk]) : chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = buf.indexOf(10)) >= 0) {
      out.push(this.#line(buf.subarray(0, nl)));
      buf = buf.subarray(nl + 1);
    }
    this.#rest = buf.length ? Buffer.from(buf) : undefined;
    return out;
  }
  end(): string[] {
    const rest = this.#rest;
    this.#rest = undefined;
    return rest ? [this.#line(rest)] : [];
  }
  #line(bytes: Buffer): string {
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 13 || bytes[end - 1] === 10)) end--;
    return this.#decoder.decode(bytes.subarray(0, end));
  }
}

export type Session = {
  pid: number;
  command(cmd: SessionCommand): void;
  /** Nobody will read its events any more: end it, sweep included. */
  close(): void;
};

/** Starts claude as `program args…` with this process's environment and working directory, `marker` set on it, and
 * hands each of its events to `onEvent`, Exited last. Rejects when it didn't start (`code` ENOENT: not there). */
export async function startSession(program: string, args: string[], sessionId: string, marker: string, onEvent: (event: RunnerEvent) => void, mapper?: StreamMapper): Promise<Session> {
  const child = spawn(program, args, {
    env: { ...process.env, [SESSION_MARKER]: marker },
    stdio: ["pipe", "pipe", "pipe"],
    // A group of its own, so the ladder signals claude's whole group and never the host's.
    detached: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return new Live(child, marker, mapper ?? new StreamMapper(sessionId, classify, warn), onEvent).handle();
}

class Live {
  readonly pid: number;
  #phase: Phase = "running";
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Everything any sweep of this session found, killed again at the exit. */
  #swept: Proc[] = [];
  #queue: RunnerEvent[] = [];
  #pendingDelta: { Delta: { message_id: string; append: string } } | undefined;
  #stdinOpen = true;
  #eventsOpen = true;
  #out = new Lines();
  #err = new Lines();
  #ended = 0;
  #endedWaiter: (() => void) | undefined;

  constructor(
    readonly child: ChildProcess,
    readonly marker: string,
    readonly mapper: StreamMapper,
    readonly onEvent: (event: RunnerEvent) => void,
  ) {
    this.pid = child.pid!;
    track(this.pid);
    child.on("error", (e) => warn(`claude: ${e.message}`));
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (chunk: Buffer) => this.#stdout(this.#out.push(chunk)));
    child.stderr!.on("data", (chunk: Buffer) => this.#stderr(this.#err.push(chunk)));
    const ended = () => {
      this.#ended++;
      this.#endedWaiter?.();
    };
    child.stdout!.once("end", () => (this.#stdout(this.#out.end()), ended()));
    child.stderr!.once("end", () => (this.#stderr(this.#err.end()), ended()));
    child.stdout!.once("error", ended);
    child.stderr!.once("error", ended);
    child.once("exit", (code, sig) => void this.#exited(code, sig));
  }

  handle(): Session {
    return { pid: this.pid, command: (cmd) => this.#command(cmd), close: () => this.#close() };
  }

  #stdout(lines: string[]): void {
    for (const line of lines) {
      const decoded = decodeLine(line);
      if (decoded) {
        const mapped = this.mapper.feed(decoded, systemNow());
        for (const reply of mapped.replies) this.#write(reply);
        this.#push(mapped.events);
      } else if (line.trim()) {
        // Not stream-json (a warning printed to stdout): keep it with stderr, where a failure shows it.
        this.mapper.stderr(line);
      }
    }
    this.#deliver();
  }

  #stderr(lines: string[]): void {
    for (const line of lines) this.mapper.stderr(line);
  }

  #command(cmd: SessionCommand): void {
    if (cmd === "Interrupt") {
      for (const input of this.mapper.stop()) this.#write(input);
    } else if ("Send" in cmd) {
      const { run_id, text, mode } = cmd.Send;
      // stdin closed: the run can never start, and ends with the exit like any other open run.
      for (const input of this.mapper.send(run_id, text, mode)) if (!this.#write(input)) warn(`send ${run_id} after stdin closed`);
    } else if ("Withdraw" in cmd) {
      const input = this.mapper.withdraw(cmd.Withdraw.run_id);
      if (!input || !this.#write(input)) {
        this.#push([{ Withdrawn: { run_id: cmd.Withdraw.run_id, cancelled: false, by_stop: false } }]);
        this.#deliver();
      }
    } else if ("Answer" in cmd) {
      const { request_id, decision, by } = cmd.Answer;
      const input = this.mapper.answer(request_id, decision, by ?? undefined, systemNow());
      if (input) this.#write(input);
      else warn(`answer to ${request_id}, which claude no longer waits for`);
    } else if ("Shutdown" in cmd) this.#shutdown(graceMs(cmd.Shutdown.grace));
  }

  #close(): void {
    this.#eventsOpen = false;
    this.#queue = [];
    this.#pendingDelta = undefined;
    this.#shutdown(0);
  }

  #shutdown(grace: number): void {
    if (this.#phase !== "running") return;
    if (this.mapper.hasOpenRun()) this.#write(this.mapper.interrupt());
    this.mapper.stopping();
    this.#stdinOpen = false;
    this.child.stdin!.end();
    this.#phase = "closing";
    this.#timer = setTimeout(() => this.#escalate(), grace);
  }

  #escalate(): void {
    // The sweep comes before the signal: once claude is gone its children can no longer be found by ppid.
    this.#swept = dedupe([...this.#swept, ...sweep(this.pid, this.marker)]);
    // claude's own group. Its pid can't be reused before the session reaps it.
    const group = (sig: NodeJS.Signals) => {
      if (this.pid > 1)
        try {
          process.kill(-this.pid, sig);
        } catch {}
    };
    if (this.#phase === "closing") {
      group("SIGTERM");
      this.#phase = "terming";
      this.#timer = setTimeout(() => this.#escalate(), TERM_GRACE_MS);
    } else if (this.#phase === "terming") {
      signal(this.#swept, "SIGKILL");
      group("SIGKILL");
      this.#phase = "killed";
    }
  }

  /** False when stdin is already closed. */
  #write(input: Input): boolean {
    if (!this.#stdinOpen) return false;
    this.child.stdin!.write(`${JSON.stringify(input)}\n`);
    return true;
  }

  #push(events: RunnerEvent[]): void {
    for (const event of events) {
      if (typeof event === "object" && "Delta" in event) {
        const held = this.#pendingDelta;
        if (held && held.Delta.message_id === event.Delta.message_id) held.Delta.append += event.Delta.append;
        else {
          this.#flushDelta();
          this.#pendingDelta = { Delta: { ...event.Delta } };
        }
      } else {
        this.#flushDelta();
        this.#queue.push(event);
      }
    }
  }

  #flushDelta(): void {
    if (this.#pendingDelta) this.#queue.push(this.#pendingDelta);
    this.#pendingDelta = undefined;
  }

  /** Hands over what is waiting; deltas already read but not merged go now too, as nothing else is waiting. */
  #deliver(): void {
    this.#flushDelta();
    const queue = this.#queue;
    this.#queue = [];
    if (this.#eventsOpen) for (const event of queue) this.onEvent(event);
  }

  async #exited(code: number | null, sig: NodeJS.Signals | null): Promise<void> {
    // Bun has collected the status; from here the pid is no longer claude's.
    untrack(this.pid);
    clearTimeout(this.#timer);
    // Whatever the session started dies with it, which also releases any pipe a descendant held.
    this.#swept = dedupe([...this.#swept, ...sweep(this.pid, this.marker)]);
    signal(this.#swept, "SIGKILL");
    if (this.#ended < 2) {
      await Promise.race([
        new Promise<void>((resolve) => (this.#endedWaiter = () => this.#ended >= 2 && resolve())),
        Bun.sleep(DRAIN_MS),
      ]);
    }
    await reap(this.#swept, REAP_MS);
    const exit: ExitInfo = {
      code: sig === null ? code : null,
      signal: sig === null ? null : (constants.signals[sig] ?? null),
      stderr_tail: this.mapper.stderrTail(),
    };
    this.#push(this.mapper.exited(exit, systemNow()));
    this.#phase = "killed";
    // On its own, so the exit is not held up by it. A later spawn of the session has another marker.
    void resweep(this.marker);
    this.#deliver();
  }
}

/** Sweeps the exited spawn marked `marker` again, for what the sweep at the exit missed: a process that was mid-`exec`
 * then had an empty environment, so no readable marker. By the marker alone: claude's pid may be another's now. */
async function resweep(marker: string): Promise<void> {
  for (let i = 0; i < RESWEEPS; i++) {
    await Bun.sleep(RESWEEP_AFTER_MS);
    const found = sweepMarked(marker);
    if (!found.length) return;
    warn(`killing ${found.length} process(es) the sweep at claude's exit missed {"marker":"${marker}"}`);
    signal(found, "SIGKILL");
    await reap(found, REAP_MS);
  }
}
