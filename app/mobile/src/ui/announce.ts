// What VoiceOver says when something changes where the person isn't looking: an answer failed, a step finished, a reply
// came. iOS has no live regions (React Native's accessibilityLiveRegion is Android's alone), so it is said outright,
// queued behind whatever VoiceOver is reading; Android's live regions say it already.
import { useEffect, useRef } from "react";
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

/** What a line says as its text goes from `said` to `text`: the new text, or nothing when it is gone or unchanged. */
export const changeToSay = (said: string | undefined, text: string | undefined): string | undefined => (text !== undefined && text !== said ? text : undefined);

/**
 * Says `text` only as it changes while the view is mounted: a row a list mounts again, or a chat opened on old history,
 * says nothing. `sayFirst` says the first text too, for a view that mounts because of what the person just did.
 */
export function useAnnounceChange(text: string | undefined, sayFirst = false): void {
  const said = useRef(sayFirst ? undefined : text);
  useEffect(() => {
    const now = changeToSay(said.current, text);
    if (now !== undefined) announce(now);
    said.current = text;
  }, [text]);
}
