import { describe, expect, it } from "bun:test";
import { forget, note, stamp } from "../src/node/screen/perf.ts";

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
