import { describe, expect, it } from "vitest";
import { calibrate, etaOf, etaText } from "./calibration.ts";

describe("calibrate", () => {
  it.each<[string, ReadonlyArray<number>, ReturnType<typeof calibrate>]>([
    ["no samples: the 5.0 prior", [], { ratio: 5, samples: 0 }],
    ["4 samples: still the prior", [1, 1, 1, 1], { ratio: 5, samples: 4 }],
    ["5 samples: the median", [3, 1, 2, 5, 4], { ratio: 3, samples: 5 }],
    ["6 samples: the mean of the middle two", [1, 2, 3, 4, 5, 6], { ratio: 3.5, samples: 6 }],
    ["10 samples: p80 by nearest rank", [10, 1, 9, 2, 8, 3, 7, 4, 6, 5], { ratio: 5.5, samples: 10, p80Ratio: 8 }],
    ["zero and non-finite ratios are dropped", [0, Number.NaN, Number.POSITIVE_INFINITY, 2, 2, 2, 2, 2], { ratio: 2, samples: 5 }],
  ])("%s", (_, ratios, expected) => {
    expect(calibrate(ratios)).toEqual(expected);
  });

  it("uses the playbook's prior below 5 samples, and the measured ratio from then on", () => {
    expect(calibrate([1, 1], 3)).toEqual({ ratio: 3, samples: 2 });
    expect(calibrate([2, 2, 2, 2, 2], 3)).toEqual({ ratio: 2, samples: 5 });
  });

  it("looks only at the latest 20 (the input is newest first)", () => {
    const latest = Array.from({ length: 20 }, () => 1.5);
    expect(calibrate([...latest, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9])).toEqual({ ratio: 1.5, samples: 20, p80Ratio: 1.5 });
  });
});

describe("etaOf and etaText", () => {
  it("scales the raw estimate by the ratio, with p80 from 10 samples", () => {
    expect(etaOf(40, { ratio: 5, samples: 2 })).toEqual({ rawMinutes: 40, calibratedMinutes: 200, ratio: 5, samples: 2 });
    expect(etaOf(30, { ratio: 2, samples: 12, p80Ratio: 3 })).toEqual({ rawMinutes: 30, calibratedMinutes: 60, ratio: 2, samples: 12, p80Minutes: 90 });
    expect(etaText(etaOf(40, { ratio: 5, samples: 2 }))).toBe("eta 3h20m (raw 40m × 5, prior, 2 of 5 samples)");
    expect(etaText(etaOf(30, { ratio: 2, samples: 12, p80Ratio: 3 }))).toBe("eta 1h (raw 30m × 2, 12 samples; p80 1h30m)");
  });
});
