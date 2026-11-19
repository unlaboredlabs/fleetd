// An agent's Android emulator in its hosted box (src/node/place/box_android.ts), without a box: the KVM check that
// refuses a box whose /dev/kvm doesn't open, the script that fetches the pinned SDK by digest and writes the device,
// and a port of this machine's that the box's link carries to a port of the box's. A real box's boot is the PR's proof
// on boat.dev.
import { afterEach, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { kvmIn, prepareScript, pull, SERIAL, startInBox } from "../../src/node/place/box_android.ts";
import { EMULATOR_PACKAGES, sdkAt } from "../../src/node/device/sdk.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A box whose every run answers `said`. */
const box = (said: string) => ({
  runs: [] as string[],
  run: async function (r: { argv: string[] }) {
    this.runs.push(r.argv.join(" "));
    return { exitCode: 0, outputTail: said, timedOut: false };
  },
  write: async () => {},
  read: async () => new Uint8Array(),
  dial: async () => {
    throw new Error("no dial");
  },
});

test("a box whose /dev/kvm doesn't open runs no emulator, and says why before fetching anything", async () => {
  expect(await kvmIn(box("ok\n") as never)).toBeUndefined();
  expect(await kvmIn(box("this sandbox has no /dev/kvm\n") as never)).toBe("this sandbox has no /dev/kvm");
  const b = box("this sandbox's /dev/kvm doesn't open for user\n");
  await expect(startInBox(b as never, { home: "/n", thread: "s1", client: sdkAt("/n") })).rejects.toThrow("this sandbox's /dev/kvm doesn't open for user, and the Android emulator needs KVM");
  expect(b.runs).toHaveLength(1);
  expect(SERIAL).toBe("emulator-5554");
});

test("the box fetches each pinned piece of the emulator once, checked by digest, and writes the device", () => {
  const script = prepareScript();
  const packages = EMULATOR_PACKAGES();
  expect(packages.map((p) => p.url.split("/").at(-1))).toEqual(["platform-tools_r37.0.1-linux.zip", "emulator-linux_x64-16428233.zip", "x86_64-35_r09.zip"]);
  for (const p of packages) {
    expect(script).toContain(p.url);
    expect(script).toContain(`echo "${p.sha1}  $R/dl/${p.url.split("/").at(-1)}" | sha1sum -c -`);
  }
  expect(script).toContain("/var/tmp/fleetd-android/avd/fleetd-android-35.avd/config.ini");
  expect(script).toContain("hw.gpu.mode=swiftshader_indirect");
  // Done once: each piece leaves a marker the next run skips it by.
  expect(script.match(/if \[ ! -e "\$R\/\.[^"]+\.done" \]; then/g)).toHaveLength(3);
});

test("a port here reaches a port of the box's through its link, both ways", async () => {
  const echo = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const port = (echo.address() as { port: number }).port;
  cleanups.push(() => echo.close());
  const dialled: number[] = [];
  const p = await pull({ dial: async (_h: string, at: number) => (dialled.push(at), connect(at, "127.0.0.1")) } as never, port);
  cleanups.push(() => p.close());
  const got = await new Promise<string>((resolve) => {
    const c = connect(p.port, "127.0.0.1", () => c.write("hello box"));
    c.on("data", (d) => {
      resolve(String(d));
      c.destroy();
    });
  });
  expect(got).toBe("hello box");
  expect(dialled).toEqual([port]);
});
