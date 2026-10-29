// How far a tab's list scrolls under the translucent tab bar (iOS draws it over the content): its height, less the
// home indicator's inset that `contentInsetAdjustmentBehavior="automatic"` already adds.
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export const useTabBarInset = (): number => {
  const tabBar = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  return Platform.OS === "ios" ? Math.max(0, tabBar - insets.bottom) : 0;
};
