// The app's few haptics, all subtle: a tap that commits something (an answer, a send's retry), a result, and a
// warning before something that can't be undone. Never awaited: a phone without haptics just doesn't buzz.
import * as Haptics from "expo-haptics";

const quietly = (p: Promise<void>): void => void p.catch(() => undefined);

export const haptics = {
  tap: (): void => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  firm: (): void => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: (): void => quietly(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: (): void => quietly(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  select: (): void => quietly(Haptics.selectionAsync()),
};
