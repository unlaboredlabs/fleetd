// The link's state in the navigation bar, never in the screen: the title reads "Connecting…" with iOS's small spinner
// beside it while the hub is dialled (link.ts), or "Updating…" while it restarts for an update (hubWord.ts). The bar
// is the same height either way, so content stays put. A screen whose bar already shows the link (the chats list's
// avatar and its dot) keeps its left side and goes without the spinner.
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Platform } from "react-native";
import { useRun } from "../desktop";
import { useHub } from "../hubContext";
import { holding, hubWord, nextChange, slowLine, type HubWord, type SlowLine } from "../hubWord";
import { LINK_GRACE_MS } from "../link";
import { useTheme } from "../theme";

/**
 * What the bar says about the hub (hubWord.ts), the line for a restart that runs long, and whether the screens hold
 * what they show rather than say the hub can't be reached; again each time one of them changes by itself.
 */
export const useHubWord = (): { readonly word: HubWord | undefined; readonly line: SlowLine | undefined; readonly hold: boolean } => {
  const { state, paired } = useHub();
  const run = useRun();
  const [now, setNow] = useState(() => Date.now());
  const input = { hub: state.hub, restart: state.restart, run, update: state.hubUpdate, now: Date.now() };
  const next = nextChange(input);
  useEffect(() => {
    if (next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next, now]);
  return { word: hubWord(input), line: slowLine({ ...input, hubName: paired.hubName }), hold: holding(input) };
};

/** The bar's word while the link is down, once it has been down a moment's grace: undefined while live, and through a wake's quick redial. */
export const useLinkDown = (): HubWord | undefined => {
  const { state } = useHub();
  const { word } = useHubWord();
  const link = state.hub.phase === "live" ? undefined : word;
  const down = link !== undefined;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), LINK_GRACE_MS);
    return () => clearTimeout(timer);
  }, [down]);
  return shown ? link : undefined;
};

/** Puts the link's state in the screen's title while it isn't live, after a moment's grace; `title` otherwise. */
export const useLinkHeader = (navigation: { setOptions: (options: Partial<NativeStackNavigationOptions>) => void }, title: string, { spinner = true }: { spinner?: boolean } = {}): void => {
  const t = useTheme();
  const link = useLinkDown();
  const text = link?.text;
  const busy = link?.busy === true;
  useLayoutEffect(() => {
    const indicator = <ActivityIndicator size="small" color={t.secondary} />;
    navigation.setOptions({
      title: text ?? title,
      ...(!spinner
        ? {}
        : Platform.OS === "ios"
          ? { unstable_headerLeftItems: () => (busy ? [{ type: "custom", element: indicator, hidesSharedBackground: true }] : []) }
          : { headerLeft: () => (busy ? indicator : null) }),
    });
  }, [navigation, title, text, busy, spinner, t.secondary]);
};
