// The W42 design preview's directions, for shooting both from one build: localStorage "fleetd.design" holds picks
// such as "footer=b,panel=a"; a key without a pick shows direction A. Prototype only: it goes once the human picks.
const picks: ReadonlyMap<string, string> = (() => {
  try {
    const raw = window.localStorage.getItem("fleetd.design") ?? "";
    return new Map(raw.split(",").flatMap((p) => {
      const [k, v] = p.split("=");
      return k && v ? [[k.trim(), v.trim()] as const] : [];
    }));
  } catch {
    return new Map();
  }
})();

export const designPick = (key: string, fallback = "a"): string => picks.get(key) ?? fallback;
