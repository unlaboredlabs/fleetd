// Desktop containers (crates/fleetd/src/node/desktop/container.rs): docker or podman, and the image they run. The image
// is built on the node from DOCKERFILE: Debian 13 pinned by digest, its packages from snapshot.debian.org at a fixed
// date, so every node builds the same Xvfb, window manager and xterm. Its tag carries a hash of the file, so a change
// builds anew; it is the Rust node's tag, so either node uses the image the other built.
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Launched } from "./screen.ts";
import { onPath, SIZE } from "./paths.ts";

/** Containers' names start so; they also carry the node's label. */
export const NAME_PREFIX = "fleetd-desktop-";

const LABEL = "fleetd.desktop";

/** The pinned image: the base by digest, its packages from the Debian snapshot of the same day. */
export const DOCKERFILE = [
  "FROM docker.io/library/debian:trixie-20261020-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad",
  "RUN rm -f /etc/apt/sources.list.d/debian.sources \\",
  " && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261020T000000Z trixie main' > /etc/apt/sources.list \\",
  " && apt-get update \\",
  " && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\",
  "      xvfb openbox xterm x11-utils fonts-dejavu-core ca-certificates \\",
  " && rm -rf /var/lib/apt/lists/*",
  "RUN mkdir -p /fleetd /home/desktop && chmod 1777 /home/desktop \\",
  " && printf '%s\\n' '#!/bin/sh' \\",
  "      'Xvfb :0 -screen 0 \"${FLEETD_SCREEN:-1280x800x24}\" -nolisten tcp -auth /fleetd/xauth -noreset &' \\",
  "      'x=$!' \\",
  "      'i=0; while [ ! -S /tmp/.X11-unix/X0 ] && [ \"$i\" -lt 400 ]; do i=$((i+1)); sleep 0.05; done' \\",
  "      'openbox >/tmp/openbox.log 2>&1 &' \\",
  "      'wait \"$x\"' > /fleetd/entry.sh \\",
  " && chmod 755 /fleetd/entry.sh",
  "ENV DISPLAY=:0 XAUTHORITY=/fleetd/xauth HOME=/home/desktop LANG=C.UTF-8",
  "WORKDIR /home/desktop",
  "CMD [\"/fleetd/entry.sh\"]",
  "",
].join("\n");

/** The tag of the image DOCKERFILE builds. */
export function image(): string {
  return `localhost/fleetd-desktop:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;
}

export type Output = { code: number | null; stdout: string; stderr: string };

/** Runs a command to its end, killed at `timeoutMs`; throws when it can't start or takes too long. */
export async function run(argv: string[], timeoutMs: number, stdin?: string): Promise<Output> {
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new Error((e as Error).message);
  }
  if (stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") {
    try {
      proc.stdin.write(stdin);
      await proc.stdin.end();
    } catch {}
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`it took over ${Math.round(timeoutMs / 1000)} s`);
  return { code, stdout, stderr };
}

/** The end of what a command said: its stderr, else its stdout. */
export function words(out: Output): string {
  const text = (out.stderr.length ? out.stderr : out.stdout).trim();
  return text.length > 800 ? text.slice(text.length - 800) : text;
}

/** docker or podman. */
export class Runtime {
  constructor(
    readonly bin: string,
    readonly podman: boolean,
    /** This node's containers carry it: its home, hashed. */
    readonly label: string,
  ) {}

  /** `FLEETD_DESKTOP_RUNTIME` (`configured`), else docker or podman on the PATH. */
  static find(configured: string | undefined, home: string): Runtime | undefined {
    const bin = configured ?? onPath("docker") ?? onPath("podman");
    if (!bin) return undefined;
    const label = createHash("sha256").update(home).digest("hex").slice(0, 16);
    return new Runtime(bin, basename(bin).includes("podman"), label);
  }

  name(): "docker" | "podman" {
    return this.podman ? "podman" : "docker";
  }

  /** Whether it answers: its daemon runs and the node's user may use it. Why not, when it doesn't. */
  async usable(): Promise<string | undefined> {
    let out: Output;
    try {
      out = await run([this.bin, "info"], 15_000);
    } catch (e) {
      return `\`${this.name()} info\` failed: ${(e as Error).message}`;
    }
    return out.code === 0 ? undefined : `\`${this.name()} info\` failed: ${words(out)}`;
  }

  async hasImage(image: string): Promise<boolean> {
    try {
      return (await run([this.bin, "image", "inspect", image], 15_000)).code === 0;
    } catch {
      return false;
    }
  }

  /** Builds DOCKERFILE as `image` (minutes, the first time), its output in `log`; throws why it failed. */
  async build(image: string, scratch: string, log: string): Promise<void> {
    const context = join(scratch, "context");
    mkdirSync(context, { recursive: true });
    const fd = openSync(log, "w");
    let code: number | null;
    try {
      const proc = Bun.spawn([this.bin, "build", "-t", image, "-f", "-", context], { stdin: "pipe", stdout: fd, stderr: fd });
      // A build that stops reading has failed or is failing: its status and log say why.
      try {
        proc.stdin.write(DOCKERFILE);
        await proc.stdin.end();
      } catch {}
      code = await proc.exited;
    } catch (e) {
      throw new Error(`cannot run ${this.bin}: ${(e as Error).message}`);
    } finally {
      closeSync(fd);
      rmSync(context, { recursive: true, force: true });
    }
    if (code !== 0) {
      let text = "";
      try {
        text = readFileSync(log, "utf8");
      } catch {}
      const tail = text.split("\n").filter((l) => l.length).reverse().slice(0, 5).join(" / ");
      throw new Error(`\`${this.name()} build\` failed: ${tail}`);
    }
  }

  /** The arguments of `run` for a display's container: its X socket folder and cookie, and at most one folder of the
   * host, read-only at the same path (the session's worktree). */
  runArgs(name: string, image: string, sockets: string, auth: string, mount: string | undefined): string[] {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const args = ["run", "-d", "--rm", "--init", "--name", name];
    args.push(
      "--label",
      `${LABEL}=${this.label}`,
      "--user",
      `${uid}:${gid}`,
      "--shm-size",
      "512m",
      "-e",
      `FLEETD_SCREEN=${SIZE[0]}x${SIZE[1]}x24`,
      "-v",
      `${sockets}:/tmp/.X11-unix`,
      "-v",
      `${auth}:/fleetd/xauth:ro`,
    );
    if (this.podman) args.push("--userns=keep-id");
    if (mount) args.push("-v", `${mount}:${mount}:ro`);
    args.push(image);
    return args;
  }

  /** Starts a display's container, detached. */
  async run(name: string, image: string, sockets: string, auth: string, mount: string | undefined): Promise<void> {
    let out: Output;
    try {
      out = await run([this.bin, ...this.runArgs(name, image, sockets, auth, mount)], 60_000);
    } catch (e) {
      throw new Error(`\`${this.name()} run\` failed: ${(e as Error).message}`);
    }
    if (out.code !== 0) throw new Error(`\`${this.name()} run\` failed: ${words(out)}`);
  }

  /** Whether the container still runs; why not, when it doesn't. */
  async running(name: string): Promise<string | undefined> {
    try {
      const out = await run([this.bin, "inspect", "-f", "{{.State.Running}}", name], 15_000);
      return out.stdout.trim() === "true" ? undefined : `its container ${name} stopped`;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async logs(name: string): Promise<string> {
    try {
      return words(await run([this.bin, "logs", "--tail", "20", name], 15_000));
    } catch {
      return "";
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await run([this.bin, "rm", "-f", name], 60_000);
    } catch (e) {
      console.warn(`desktop container ${name} not removed: ${(e as Error).message}`);
    }
  }

  /** Removes this node's containers a node that died left behind; how many. */
  async removeLeftovers(): Promise<number> {
    let out: Output;
    try {
      out = await run([this.bin, "ps", "-aq", "--filter", `label=${LABEL}=${this.label}`], 15_000);
    } catch {
      return 0;
    }
    const ids = out.stdout.split(/\s+/).filter(Boolean);
    for (const id of ids) await this.remove(id);
    return ids.length;
  }

  /** Starts `command` in a display's container, in `cwd` when the container sees it, and looks at it a moment later. */
  async launch(name: string, command: string, cwd: string, n: number, settleMs: number): Promise<Launched> {
    const log = `/tmp/launch-${n}.log`;
    let out: Output;
    try {
      out = await run([this.bin, "exec", name, "sh", "-c", 'cd "$1" 2>/dev/null; sh -c "$2" >"$3" 2>&1 & echo $!', "sh", cwd, command, log], 30_000);
    } catch (e) {
      throw new Error(`\`${this.name()} exec\` failed: ${(e as Error).message}`);
    }
    const pid = Number(out.stdout.trim());
    if (!out.stdout.trim() || !Number.isInteger(pid)) throw new Error(`\`${this.name()} exec\` failed: ${words(out)}`);
    await Bun.sleep(settleMs);
    const seen = (
      await run([this.bin, "exec", name, "sh", "-c", 'if kill -0 "$1" 2>/dev/null; then echo running; else tail -c 1500 "$2"; fi', "sh", String(pid), log], 30_000)
    ).stdout.trim();
    return seen === "running" ? { pid } : { pid, exited: { code: null, output: seen } };
  }
}
