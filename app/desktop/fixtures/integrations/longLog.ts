// integrations-approvals-long: a busy YOLO project's log of what ran without asking, 400 entries with runs of the same
// action, answered in pages as the hub answers them (W601): the first page, each older page from its cursor, and an
// older app's read with no limit, which gets the newest 200.
import type { JsonObject } from "../kit/json.ts";
import { FIRST_PAGE, PAGE } from "../../src/renderer/screens/settings/approvedLog.ts";

const SIZE = 400;
/** What an older app's read gets: the hub's AUTO_APPROVED_MAX. */
const OLD_MAX = 200;
const NEWEST = Date.parse("2026-10-31T16:42:00.000Z");

/** The actions, each with how many times it runs in a row when it comes up. */
const ACTIONS: ReadonlyArray<{ tool: string; what: string; run: number; reason?: string }> = [
  { tool: "WebFetch", what: "Fetch `docs.python.org`", run: 3 },
  { tool: "mcp__gmail__send_message", what: "`send_message` on `gmail`, to sam@example.com", run: 1 },
  { tool: "mcp__fleetd__browser_open", what: "Open `lupa.example`", run: 1 },
  { tool: "mcp__linear__create_issue", what: "`create_issue` on `linear`", run: 2 },
  { tool: "WebFetch", what: "Fetch `api.github.com`", run: 4 },
  { tool: "mcp__fleetd__confirm_step", what: 'Click "Complete reservation" on `lupa.example`', run: 1, reason: "you asked to book Lupa for two on Saturday at 8" },
  { tool: "mcp__slack__post_message", what: "`post_message` on `slack`, to #general", run: 1 },
  { tool: "WebFetch", what: "Fetch `dentist-lisboa.example`", run: 2, reason: "you asked for the dentist's opening hours, and this is its own site" },
];

/** Newest first, each with its row number (the hub's cursor), newest highest. */
export const longLog = (): Array<{ n: number; entry: JsonObject }> => {
  const out: Array<{ n: number; entry: JsonObject }> = [];
  for (let k = 0; out.length < SIZE; k += 1) {
    const a = ACTIONS[k % ACTIONS.length];
    if (a === undefined) break;
    for (let r = 0; r < a.run && out.length < SIZE; r += 1) {
      const at = new Date(NEWEST - out.length * 7 * 60_000).toISOString();
      const entry: JsonObject =
        a.reason === undefined
          ? { at, by: "yolo", tool: a.tool, what: a.what }
          : { at, by: "checker", tool: a.tool, what: a.what, reason: a.reason, messageId: `m${String(SIZE - out.length)}` };
      out.push({ n: SIZE - out.length, entry });
    }
  }
  return out;
};

/** The approvals read's answers: [input beyond the project's ref, output beyond approvals]. */
export const longLogPages = (): Array<[JsonObject, JsonObject]> => {
  const log = longLog();
  const page = (from: number, limit: number): JsonObject => {
    const shown = log.slice(from, from + limit);
    const last = shown[shown.length - 1];
    return { log: shown.map((e) => e.entry), ...(from + limit < log.length && last !== undefined ? { older: last.n } : {}), total: log.length };
  };
  const out: Array<[JsonObject, JsonObject]> = [
    [{}, page(0, OLD_MAX)],
    [{ limit: FIRST_PAGE }, page(0, FIRST_PAGE)],
  ];
  // Each older page starts below the row the page before ended on: entry `from - 1`, numbered `log.length - from + 1`.
  for (let from = FIRST_PAGE; from < log.length; from += PAGE) out.push([{ limit: PAGE, before: log.length - from + 1 }, page(from, PAGE)]);
  return out;
};
