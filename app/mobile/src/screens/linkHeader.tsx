// The link's state in the navigation bar, never in the screen: the title reads "Connecting…" with iOS's small spinner
// beside it while the hub is dialled (link.ts). The bar is the same height either way, so content stays put. A screen
// whose bar already shows the link (the chats list's avatar and its dot) keeps its left side and goes without the spinner.
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Platform } from "react-native";
import { useHub } from "../hubContext";
import { LINK_GRACE_MS, linkStatus } from "../link";
import { useTheme } from "../theme";

/** The link's state once it has been down a moment's grace: undefined while live, and through a wake's quick redial. */
export const useLinkDown = (): ReturnType<typeof linkStatus> => {
  const { state } = useHub();
  const link = linkStatus(state.hub);
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
