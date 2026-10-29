// Pull to refresh, as iOS's lists do it: the spinner stays while the hub is asked again.
import { useEffect, useState } from "react";

/** Pull to refresh's spinner: on from the pull until what it reads again (`read`) lands or the link gives up, 8 s at most. */
export const useRefreshing = (read: unknown, phase: string): { on: boolean; start: (go: () => void) => void } => {
  const [since, setSince] = useState<unknown>(null);
  const on = since !== null;
  useEffect(() => {
    if (!on) return;
    if (read !== since || phase === "refused" || phase === "retrying") {
      setSince(null);
      return;
    }
    const timer = setTimeout(() => setSince(null), 8000);
    return () => clearTimeout(timer);
  }, [on, since, read, phase]);
  return {
    on,
    start: (go) => {
      setSince(read);
      go();
    },
  };
};
