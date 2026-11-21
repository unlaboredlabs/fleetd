// An agent's Android emulator in its own hosted box, as its browser and Linux desktop are (./box_screens.ts): a
// provider stays in fleetd only where its boxes run the emulator with KVM (D576), so a hosted agent's phone is beside
// its files, on its network. The box gets fleetd's pinned emulator, its image and platform-tools once (about 1.2 GB,
// a minute or so; ../device/sdk.ts PACKAGES, checked by digest), boots the device cold, and runs the adb server the
// emulator registers with. Everything the node does with an emulator stays as on a machine: its own adb client (the
// pinned platform-tools, ../device/sdk.ts installClient) talks to the box's adb server through a port of this
// machine's that the box's link carries (`pull`), and so does scrcpy's stream, which the node decodes, records and
// streams to the live view. The agent's agent-device runs in the box, from the node's own pinned copy mirrored there,
// with a wrapper at the same path as on the node pointed at the box's SDK; the person's takeover reaches it as the
// control file the wrapper checks. The box's own side (its scripts, its pid files) is ./box_emulator.ts, which a holder
// with no node drives the same box's emulator through.
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { entry, installDir as agentDeviceDir, binDir, controlPath, sessionDir, wrapperScript } from "../device/agent_device.ts";
import type { Lent } from "../device/emulator.ts";
import { ADB_SERVER_PORT, type Sdk } from "../device/sdk.ts";
import { type AndroidBox, BOX_ROOT, boxSdk, kvmIn, prepareScript, SERIAL, sh, startScript, stopEmulator } from "./box_emulator.ts";
import { mirror } from "../sandbox/remote/files.ts";
import type { Box } from "../sandbox/box.ts";

/** The box's side, shared with a holder that has no node (./box_emulator.ts). */
export { type AndroidBox, BOX_ROOT, boxSdk, CONSOLE, kvmIn, prepareScript, SERIAL, startScript } from "./box_emulator.ts";

/** How long the emulator may take to boot once the SDK is in the box (fetching it has its own 900 s, prepareScript). */
export const timing = { upMs: 300_000 };

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const enc = (s: string) => new TextEncoder().encode(s);

/** A port of this machine's whose connections the box's guest makes to `port` on the box's loopback. */
export async function pull(box: Pick<Box, "dial">, port: number): Promise<{ port: number; close(): void }> {
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.pause();
    void box.dial("127.0.0.1", port).then(
      (there: Duplex) => {
        sock.pipe(there);
        there.pipe(sock);
        const end = () => {
          sock.destroy();
          there.destroy();
        };
        sock.once("close", end);
        there.once("close", end);
        there.once("error", end);
        sock.once("error", end);
        sock.resume();
      },
      () => sock.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const here = typeof address === "object" && address ? address.port : 0;
  return {
    port: here,
    close: () => {
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}

export type BoxedEmulator = { lent: Lent; sdk: Sdk };

/**
 * The agent's emulator in its box, booted: what a session drives as one the node lent (../device/index.ts), with the
 * node's client SDK pointed at the box's adb server. `client` is the node's own adb, scrcpy server and ffmpeg.
 */
export async function startInBox(box: AndroidBox, o: { home: string; thread: string; client: Sdk }): Promise<BoxedEmulator> {
  const why = await kvmIn(box);
  if (why) throw new Error(`${why}, and the Android emulator needs KVM`);
  await sh(box, prepareScript(), 900);
  // The agent's agent-device: the node's pinned copy at the same path, its wrapper pointed at the box's SDK.
  await mirror(box, [join(agentDeviceDir(o.home), "node_modules"), join(agentDeviceDir(o.home), "plugin")]);
  await box.write(join(binDir(o.home), "agent-device"), enc(wrapperScript(entry(o.home), boxSdk())), 0o755);
  await box.write(join(sessionDir(o.home, o.thread), "config.json"), enc(`${JSON.stringify({ platform: "android", serial: SERIAL })}\n`), 0o600);
  const pidFile = `${BOX_ROOT}/emulator.pid`;
  await sh(box, startScript(pidFile));
  const deadline = Date.now() + timing.upMs;
  for (;;) {
    const said = await sh(box, `${shq(boxSdk().adb)} -s ${SERIAL} shell getprop sys.boot_completed 2>/dev/null || true`, 30).catch(() => "");
    if (said.trim() === "1") break;
    if (Date.now() > deadline) {
      const log = await sh(box, `tail -c 800 ${shq(`${BOX_ROOT}/emulator.log`)} 2>/dev/null || true`).catch(() => "");
      await stopIn(box, pidFile);
      throw new Error(`the emulator in the sandbox didn't boot within ${timing.upMs / 1000} s${log.trim() ? `: ${log.trim()}` : ""}`);
    }
    await Bun.sleep(2_000);
  }
  // Settled for automation, as the node's own device is (../device/sdk.ts snapshot).
  await sh(box, ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"].map((k) => `${shq(boxSdk().adb)} -s ${SERIAL} shell settings put global ${k} 0`).join("; "), 60).catch(() => "");
  const adbHere = await pull(box, ADB_SERVER_PORT);
  const forwards: { close(): void }[] = [adbHere];
  const sdk: Sdk = {
    ...o.client,
    adbPort: adbHere.port,
    reach: async (port) => {
      const p = await pull(box, port);
      forwards.push(p);
      return p.port;
    },
  };
  const control = controlPath(o.home, o.thread);
  const lent: Lent = {
    emulator: { serial: SERIAL, pushed: false },
    release: () => {
      for (const f of forwards.splice(0)) f.close();
      void stopIn(box, pidFile);
    },
    control: (human) => void (human ? box.write(control, enc("human\n"), 0o600) : sh(box, `rm -f ${shq(control)}`)).catch(() => {}),
  };
  return { lent, sdk };
}

/** Kills the emulator's process session, and the box's adb server (./box_emulator.ts, whose pid file it is). */
const stopIn = (box: AndroidBox, _pidFile: string) => stopEmulator(box);
