// The clock the screens word times by: the phone's locale and zone, ticking each minute so "Today" turns "Yesterday".
import { useEffect, useState } from "react";
import type { Clock } from "../chatView";

export const useNow = (): Clock => {
  const [nowMs, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return { nowMs };
};
