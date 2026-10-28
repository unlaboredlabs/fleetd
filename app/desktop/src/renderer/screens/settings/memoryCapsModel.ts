// The memory caps as Settings → Projects → Instructions & memory edits them: four numbers, each checked against the range the hub takes before
// memory_caps_set goes.
import { MEMORY_CAP_MIN, MEMORY_FILE_CAP_MAX, MEMORY_PROJECT_CAP_MAX, type MemoryCaps } from "../../../shared/contracts";

export type CapKey = keyof MemoryCaps;
export type CapsDraft = Readonly<Record<CapKey, string>>;

export const CAP_FIELDS: ReadonlyArray<{ readonly key: CapKey; readonly label: string; readonly help: string }> = [
  { key: "user", label: "user.md", help: "How you work, sent to every project." },
  { key: "index", label: "Each MEMORY.md", help: "A project's always-on part and its topic list." },
  { key: "topic", label: "Each topic file", help: "Opened by the lead when it needs it." },
  { key: "project", label: "Each project in all", help: "MEMORY.md and its topics together." },
];

const fmt = (n: number) => n.toLocaleString("en-US");

export const draftOf = (caps: MemoryCaps): CapsDraft => ({
  user: String(caps.user),
  index: String(caps.index),
  topic: String(caps.topic),
  project: String(caps.project),
});

/** The caps to send, or the first field's problem in a sentence. Commas and spaces in a number are fine. */
export const parseCaps = (draft: CapsDraft): { ok: true; caps: MemoryCaps } | { ok: false; key: CapKey; reason: string } => {
  const caps: Partial<Record<CapKey, number>> = {};
  for (const { key, label } of CAP_FIELDS) {
    const raw = draft[key].replace(/[\s,]/gu, "");
    const max = key === "project" ? MEMORY_PROJECT_CAP_MAX : MEMORY_FILE_CAP_MAX;
    const n = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(n) || n < MEMORY_CAP_MIN || n > max) {
      return { ok: false, key, reason: `${label}: a whole number of characters from ${fmt(MEMORY_CAP_MIN)} to ${fmt(max)}.` };
    }
    caps[key] = n;
  }
  return { ok: true, caps: caps as MemoryCaps };
};
