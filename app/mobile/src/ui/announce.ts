// What VoiceOver says when something changes where the person isn't looking: an answer failed, a step finished, a reply
// came. iOS has no live regions (React Native's accessibilityLiveRegion is Android's alone), so it is said outright,
// queued behind whatever VoiceOver is reading; Android's live regions say it already.
import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";

export const announce = (text: string): void => {
  if (Platform.OS === "ios" && text !== "") AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
};

/** Says `text` each time it changes to something new; nothing for undefined. */
export function useAnnounce(text: string | undefined): void {
  useEffect(() => {
    if (text !== undefined) announce(text);
  }, [text]);
}
