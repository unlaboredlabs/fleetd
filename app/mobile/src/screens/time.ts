// The clock the screens word times by: the phone's locale and zone, ticking each minute so "Today" turns "Yesterday".
// One clock for every view (minuteClock.ts).
import { useSyncExternalStore } from "react";
import type { Clock } from "../chatView";
import { clock } from "../minuteClock";

export const useNow = (): Clock => ({ nowMs: useSyncExternalStore(clock.subscribe, clock.now) });
