// The sweeps' bad-network harness (scripts/netem.ts): delay, bandwidth, loss and each kind of outage behave as its
// header says, so every before/after number taken through it means what the report says it means.
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { PROFILES, startNetem, type Netem } from "../../scripts/netem.ts";

const echo = async () => {
  const server = net.createServer((s) => s.on("data", (d) => s.write(d)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as net.AddressInfo).port };
};

const open: Array<{ close: () => unknown }> = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
});

const rig = async (opts: Partial<Parameters<typeof startNetem>[0]>) => {
  const e = await echo();
  open.push({ close: () => new Promise((r) => { e.server.close(r); }) });
  const n = await startNetem({ target: e.port, ...opts });
  open.push(n);
  return n;
};

/** Connects, sends `bytes`, resolves with ms until all of it came back (or null if it didn't within `ms`). */
const roundTrip = (n: Netem, bytes: number, ms = 5000) =>
  new Promise<{ ms: number | null; socket: net.Socket }>((resolve) => {
    const socket = net.connect(n.port, "127.0.0.1");
    let got = 0;
    let t0 = 0;
    const timer = setTimeout(() => resolve({ ms: null, socket }), ms);
    socket.on("connect", () => {
      t0 = performance.now();
      socket.write(Buffer.alloc(bytes, 120));
    });
    socket.on("data", (d) => {
      got += d.length;
      if (got >= bytes) {
        clearTimeout(timer);
        resolve({ ms: performance.now() - t0, socket });
      }
    });
    socket.on("error", () => {});
    open.push({ close: () => socket.destroy() });
  });

describe("netem", () => {
  test("every named profile the sweeps use exists", () => {
    for (const name of ["3g", "satellite", "lossy-wifi", "flapping", "tiny-bandwidth", "clean"]) expect(PROFILES[name]).toBeDefined();
    expect(PROFILES.satellite!.rtt).toBe(0.6);
    expect(PROFILES["lossy-wifi"]!.loss).toBe(0.05);
    expect(PROFILES.flapping!.flap).toEqual({ every: 30, for: 5 });
    expect(PROFILES["tiny-bandwidth"]!.downBps).toBe(256e3);
  });

  test("adds the round trip: handshake plus one trip there and back", async () => {
    const n = await rig({ overrides: { rtt: 0.2 } });
    const { ms } = await roundTrip(n, 10);
    // 200 ms handshake (counted from connect on the client side, the proxy's dial waits it) + 200 ms there and back.
    expect(ms!).toBeGreaterThan(350);
    expect(ms!).toBeLessThan(900);
    expect(n.stats()).toMatchObject({ up: 10, down: 10, conns: 1 });
  });

  test("paces bytes at the bandwidth cap", async () => {
    const n = await rig({ overrides: { upBps: 400e3, downBps: 4e9 } });
    const { ms } = await roundTrip(n, 20_000);
    // 20 kB plus headers at 400 kbit/s is ~420 ms one way.
    expect(ms!).toBeGreaterThan(380);
    expect(n.stats().wireUp).toBeGreaterThan(20_000);
  });

  test("a cut loses open connections silently and lets new ones through after", async () => {
    const n = await rig({});
    const first = await roundTrip(n, 10);
    expect(first.ms).not.toBeNull();
    n.cut(0.3);
    let closed = false;
    first.socket.on("close", () => (closed = true));
    let echoed = 0;
    first.socket.on("data", (d) => (echoed += d.length));
    first.socket.write("lost");
    const during = roundTrip(n, 10, 3000);
    await Bun.sleep(500);
    expect(echoed).toBe(0);
    expect(closed).toBe(false); // neither end is told
    expect((await during).ms).not.toBeNull(); // dialled during the cut, it hung and went through after
    expect(n.stats().killed).toBe(1);
  });

  test("a stall holds bytes and delivers them all after", async () => {
    const n = await rig({});
    const first = await roundTrip(n, 10);
    n.stall(0.3);
    const t0 = performance.now();
    const back = new Promise<number>((r) => first.socket.once("data", () => r(performance.now() - t0)));
    first.socket.write("held");
    expect(await back).toBeGreaterThan(250);
  });

  test("a drop resets connections and refuses new ones for its length", async () => {
    const n = await rig({});
    const first = await roundTrip(n, 10);
    const closed = new Promise<void>((r) => first.socket.once("close", () => r()));
    n.drop(0.3);
    await closed;
    const during = await roundTrip(n, 10, 200);
    expect(during.ms).toBeNull();
    await Bun.sleep(300);
    expect((await roundTrip(n, 10)).ms).not.toBeNull();
  });

  test("flap takes the link down on a timer", async () => {
    const n = await rig({ profile: { ...PROFILES.clean!, flap: { every: 0.2, for: 0.1 } } });
    await Bun.sleep(250);
    expect(n.down()).toBe(true);
    await Bun.sleep(120);
    expect(n.down()).toBe(false);
  });

  test("loss stalls and retransmits, counted on the wire", async () => {
    const n = await rig({ overrides: { loss: 1, rtt: 0.02 } });
    const { ms } = await roundTrip(n, 100);
    expect(ms!).toBeGreaterThan(400); // two RTO stalls of ~220 ms
    expect(n.stats().wireUp).toBe(2 * (100 + 52));
  });
});
