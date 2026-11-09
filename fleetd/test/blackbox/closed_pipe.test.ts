// A reader that goes away (`fleetd … | head -1`): a one-shot command ends quietly with 0, while a pipe into a child
// that exits early (the binary streamed into ssh) still fails its step with the child's error, and the hub keeps
// SIGPIPE ignored.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { TESTED } from "../../src/node/runner/claude.ts";
import { tempHome } from "../helpers.ts";
import { BIN, cleanEnv, freePort, run, script, type Ran } from "./kit.ts";

setDefaultTimeout(90_000);

const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done();
});

/** A throwaway user with a fleet of its own under FLEETD_HOME, and the address its hub listens on. */
function fleet() {
  const home = tempHome();
  cleanups.push(home.done);
  for (const sub of ["user", "xdg", "bin"]) mkdirSync(join(home.dir, sub));
  const path = (sub: string) => join(home.dir, sub);
  const env = (more: Record<string, string> = {}) =>
    cleanEnv({ HOME: path("user"), XDG_CONFIG_HOME: path("xdg"), FLEETD_HOME: path("fleet"), ...more });
  return { path, env, listen: `127.0.0.1:${freePort()}` };
}

/** `fleetd init --no-service`, then its hub, up and listening; killed when the test ends. */
async function hub(f: ReturnType<typeof fleet>) {
  const init = await run([BIN!, "init", "--no-service", "--listen", f.listen], f.env());
  expect(init.code, init.stderr).toBe(0);
  const child = Bun.spawn([BIN!, "hub", "start", "--listen", f.listen], { env: f.env(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => child.kill("SIGKILL"));
  const [host, port] = f.listen.split(":");
  const deadline = Date.now() + 60_000;
  while (!(await listening(host!, Number(port)))) {
    expect(child.exitCode, "the hub exited").toBeNull();
    expect(Date.now() < deadline, "the hub never listened").toBe(true);
    await Bun.sleep(50);
  }
  return child;
}

const listening = (host: string, port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect(port, host, () => (socket.end(), done(true)));
    socket.on("error", () => done(false));
  });

/** Runs `argv` with stdout on a pipe whose read end is closed before it starts, as `head` leaves it. */
async function intoClosedPipe(argv: string[], env: Record<string, string>): Promise<Ran> {
  const fds = new Int32Array(2);
  expect(libc.symbols.pipe(ptr(fds))).toBe(0);
  libc.symbols.close(fds[0]!);
  try {
    return await run(argv, env, fds[1]!);
  } finally {
    libc.symbols.close(fds[1]!);
  }
}

function endsQuietly(out: Ran) {
  expect(out.stderr).not.toContain("panicked");
  expect(out.signal, out.stderr).toBeNull();
  expect(out.code, out.stderr).toBe(0);
}

test.skipIf(!BIN)("help ends quietly when its reader is gone", async () => {
  const f = fleet();
  endsQuietly(await intoClosedPipe([BIN!, "project", "--help"], f.env()));
});

test.skipIf(!BIN)("a command ends quietly when its reader is gone", async () => {
  const f = fleet();
  await hub(f);
  endsQuietly(await intoClosedPipe([BIN!, "project", "list"], f.env()));
});

test.skipIf(!BIN || process.platform !== "linux")("the hub keeps SIGPIPE ignored", async () => {
  const f = fleet();
  const child = await hub(f);
  const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
  const mask = BigInt(`0x${status.match(/^SigIgn:\s*([0-9a-f]+)$/m)![1]}`);
  const SIGPIPE = 13n;
  expect(mask & (1n << (SIGPIPE - 1n)), status).not.toBe(0n);
});

test.skipIf(!BIN)("a child that stops reading still fails its step", async () => {
  const f = fleet();
  await hub(f);
  // An ssh that runs each command here, except that it gives up on the binary without reading it, as one whose
  // connection drops or whose disk is full does; and the claude the machine needs, which CI has none of.
  script(
    join(f.path("bin"), "ssh"),
    'for last; do :; done\ncase "$last" in\n  *fleetd-tmp*) echo \'devbox: disk full\' >&2; exit 7 ;;\nesac\nexec sh -c "$last"\n',
  );
  script(join(f.path("bin"), "claude"), `echo '${TESTED} (Claude Code)'\n`);
  const out = await run([BIN!, "machine", "add", "devbox-worker", "--no-service"], f.env({ PATH: `${f.path("bin")}:${process.env.PATH ?? ""}` }));
  expect(out.signal, `not killed by SIGPIPE: ${out.stderr}`).toBeNull();
  expect(out.code, out.stderr).toBe(1);
  expect(out.stderr).toContain("failed (exit 7)");
  expect(out.stderr).toContain("devbox: disk full");
});
