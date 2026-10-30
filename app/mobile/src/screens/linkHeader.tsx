// The link's state in the navigation bar, never in the screen: the title reads "Connecting…" with iOS's small spinner
// beside it while the hub is dialled (link.ts). The bar is the same height either way, so content stays put.
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Platform } from "react-native";
import { useHub } from "../hubContext";
import { LINK_GRACE_MS, linkStatus } from "../link";
import { useTheme } from "../theme";

/** Puts the link's state in the screen's title while it isn't live, after a moment's grace; `title` otherwise. */
export const useLinkHeader = (navigation: { setOptions: (options: Partial<NativeStackNavigationOptions>) => void }, title: string): void => {
  const t = useTheme();
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
  const text = shown ? link?.text : undefined;
  const busy = shown && link?.busy === true;
  useLayoutEffect(() => {
    const spinner = <ActivityIndicator size="small" color={t.secondary} />;
    navigation.setOptions({
      title: text ?? title,
      ...(Platform.OS === "ios"
        ? { unstable_headerLeftItems: () => (busy ? [{ type: "custom", element: spinner, hidesSharedBackground: true }] : []) }
        : { headerLeft: () => (busy ? spinner : null) }),
    });
  }, [navigation, title, text, busy, t.secondary]);
};
