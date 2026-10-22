// "Offline, as of 09:02": the words for data shown from before the connection dropped (or from the disk cache at
// launch), shared by the banner, the sidebar and the chat header so they always name the same time.
import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { selectOfflineAsOf } from "../../src/data/selectors";
import { dayLabel } from "../chat/model";

const hm = new Map<string, Intl.DateTimeFormat>();

const hourMinute = (ms: number, timeZone?: string): string => {
  const key = timeZone ?? "";
  let f = hm.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) });
    hm.set(key, f);
  }
  return f.format(ms);
};

/** "as of 09:02"; with the day when it wasn't today: "as of yesterday 18:40", "as of Mon 19 Oct 18:40". */
export function asOfWords(asOfMs: number, nowMs: number, timeZone?: string): string {
  const day = dayLabel(new Date(asOfMs).toISOString(), nowMs, timeZone);
  const time = hourMinute(asOfMs, timeZone);
  return day === "Today" ? `as of ${time}` : `as of ${day === "Yesterday" ? "yesterday" : day} ${time}`;
}

/** "as of 09:02" for `asOfMs`; undefined without one. */
export const useAsOfWords = (asOfMs: number | undefined): string | undefined =>
  // Read against the clock when the time changes; a label that only names a day needs no tick.
  // eslint-disable-next-line react-hooks/purity
  useMemo(() => (asOfMs === undefined ? undefined : asOfWords(asOfMs, Date.now())), [asOfMs]);

/** "as of 09:02" while held data is shown without a connection; undefined when live or nothing is held. */
export const useOfflineAsOf = (): string | undefined => useAsOfWords(useData(selectOfflineAsOf));
