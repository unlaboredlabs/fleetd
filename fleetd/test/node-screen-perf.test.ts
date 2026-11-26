import { describe, expect, it } from "bun:test";
import { forget, note, relay, stamp } from "../src/node/screen/perf.ts";

const frame = (seq: number) => ({ sessionId: "perf-s", seq, width: 1280, height: 800, control: "agent", jpegB64: "x".repeat(4000) }) as never as Parameters<typeof stamp>[0];

describe("screen perf stamps", () => {
  it("stamps one frame a second with the frames sent so far and its own number", () => {
    forget("perf-s");
    const stamped = [];
    for (let i = 1; i <= 90; i++) {
      const f = frame(i);
      stamp(f, i * (1000 / 30), () => ({ cores: 8, cpuPct: 20 }));
      if (f.perf !== undefined) stamped.push(f.perf);
    }
    expect(stamped.length).toBe(2);
    expect(stamped[0]).toMatchObject({ sent: stamped[0]!.seq, madeFps: 30, cores: 8, cpuPct: 20 });
  });
  it("says what held it for the whole second, though only one frame was held", () => {
    forget("perf-s");
    let last;
    for (let i = 1; i <= 40; i++) {
      note("perf-s", { capBy: i === 5 ? "link" : undefined });
      const f = frame(i);
      stamp(f, i * (1000 / 30));
      if (f.perf !== undefined) last = f.perf;
    }
    expect(last?.capBy).toBe("link");
  });
});

describe("screen perf stamps away from the screen's machine", () => {
  it("leaves out the machine where none is given (the process isn't on it)", () => {
    forget("perf-s");
    let last;
    for (let i = 1; i <= 40; i++) {
      const f = frame(i);
      stamp(f, i * (1000 / 30));
      if (f.perf !== undefined) last = f.perf;
    }
    expect(last).toBeDefined();
    expect(last).not.toHaveProperty("cores");
    expect(last).not.toHaveProperty("cpuPct");
    expect(last).not.toHaveProperty("memPct");
  });
});

describe("screen perf stamps of frames sent again or made elsewhere", () => {
  it("counts the newest frame sent again for a new watcher once", () => {
    forget("perf-s");
    let last;
    for (let i = 1; i <= 40; i++) {
      const f = frame(i);
      stamp(f, i * (1000 / 30));
      // Each frame again, as a watch `on` sends the newest anew.
      stamp(frame(i), i * (1000 / 30) + 1);
      if (f.perf !== undefined) last = f.perf;
    }
    expect(last).toMatchObject({ sent: 31, seq: 31, madeFps: 30 });
  });
  it("leaves a relayed session's frames with the measures they came with", () => {
    forget("perf-s");
    relay("perf-s", true);
    const came = { sent: 7, seq: 7, madeFps: 30, madeKbps: 900, encoder: "x264" };
    for (let i = 1; i <= 40; i++) {
      const f = frame(i);
      if (i === 35) f.perf = came;
      stamp(f, i * (1000 / 30), () => ({ cores: 64, cpuPct: 99 }));
      expect(f.perf).toBe(i === 35 ? came : undefined);
    }
    relay("perf-s", false);
  });
});
