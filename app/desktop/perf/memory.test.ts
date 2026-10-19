import { describe, expect, it } from "vitest";
import { account, kindOf, parsePs, parseTopMem, tree } from "./memory.ts";

const PS = `    1     0  1000 /sbin/launchd
  500     1 160000 /Applications/fleetd.app/Contents/MacOS/fleetd --user-data-dir=/tmp/x
  501   500 140000 /Applications/fleetd.app/Contents/Frameworks/fleetd Helper (GPU).app/Contents/MacOS/fleetd Helper (GPU) --type=gpu-process --x
  502   500 90000 /Applications/fleetd.app/Contents/Frameworks/fleetd Helper (Renderer).app/Contents/MacOS/fleetd Helper (Renderer) --type=renderer
  503   500 80000 /Applications/fleetd.app/Contents/Frameworks/fleetd Helper.app/Contents/MacOS/fleetd Helper --type=utility --utility-sub-type=network.mojom.NetworkService
  600     1  5000 /usr/bin/other`;

// What `top -l 1 -stats pid,mem` prints: a header block, then one row per process.
const TOP = `Processes: 612 total, 3 running, 609 sleeping, 3011 threads
Load Avg: 2.10, 2.02, 1.95
PID    MEM
503    21M
502    48M+
501    1024K
500    0.1G-
600    3M`;

describe("memory", () => {
  const procs = tree(parsePs(PS), 500);

  it("walks the app's tree and names each process", () => {
    expect(procs.map((p) => p.pid)).toEqual([500, 501, 502, 503]);
    expect(procs.map((p) => kindOf(p.args))).toEqual(["browser", "gpu-process", "renderer", "utility"]);
  });

  it("reads top's MEM column in its units", () => {
    const mem = parseTopMem(TOP);
    expect(mem.get(502)).toBe(48 * 1024);
    expect(mem.get(501)).toBe(1024);
    expect(mem.get(500)).toBeCloseTo(0.1 * 1024 * 1024);
    expect(mem.has(612)).toBe(false);
  });

  it("sums deduplicated and resident memory over every process it read", () => {
    const sum = account(procs, parseTopMem(TOP), () => true);
    expect(sum.processes).toBe(4);
    expect(sum.uniqueKb).toBeCloseTo(21 * 1024 + 48 * 1024 + 1024 + 0.1 * 1024 * 1024);
    expect(sum.rssKb).toBe(470_000);
  });

  it("fails on a live process it could not read, never counting it as 0", () => {
    const partial = new Map([...parseTopMem(TOP)].filter(([pid]) => pid !== 502));
    expect(() => account(procs, partial, () => true)).toThrow(/502 \(renderer\)/u);
    // One that exited between ps and the read is gone, not unread; but then the renderer is missing.
    expect(() => account(procs, partial, (pid) => pid !== 502)).toThrow(/no renderer/u);
  });

  it("fails when the browser, a renderer or the GPU process is missing", () => {
    const noGpu = procs.filter((p) => kindOf(p.args) !== "gpu-process");
    expect(() => account(noGpu, parseTopMem(TOP), () => true)).toThrow(/no gpu-process/u);
  });
});
