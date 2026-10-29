// The OS side of push.ts, through expo-notifications with the platforms' own push (APNs, FCM), never Expo's service:
// the device token, Android's channels, the background task that opens and posts an Android notification, and what a
// tap opens. index.ts loads this module first, so the task is defined when Android starts the app headless for an FCM
// data message. iOS shows its notifications through the Notification Service Extension instead.
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { useEffect } from "react";
import { Platform } from "react-native";
import { androidShown, CHANNELS, tapRoute, type Channel, type PushDeps, type Route, type Shown } from "./push";
import { loadPushDevice, loadPushKeys, pushKeys, savePushDevice } from "./vault";

const TASK = "fleetd-push";

export const pushDeps: PushDeps = {
  platform: Platform.OS === "ios" ? "ios" : "android",
  deviceName: Device.deviceName ?? (Platform.OS === "ios" ? "iPhone" : "Android phone"),
  keys: pushKeys,
  token: async () => {
    // Asks once; a phone that said no gets nothing, so isn't registered.
    if (!(await Notifications.requestPermissionsAsync()).granted) return null;
    const token = await Notifications.getDevicePushTokenAsync();
    return typeof token.data === "string" ? token.data : null;
  },
  onToken: (listener) => {
    const sub = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === "string") listener(token.data);
    });
    return () => sub.remove();
  },
  saveDevice: savePushDevice,
  loadDevice: loadPushDevice,
};

const channels = async (): Promise<void> => {
  for (const [id, channel] of Object.entries(CHANNELS)) {
    await Notifications.setNotificationChannelAsync(id, {
      name: channel.name,
      importance: channel.sound ? Notifications.AndroidImportance.HIGH : Notifications.AndroidImportance.LOW,
      sound: channel.sound ? "default" : null,
      enableVibrate: channel.sound,
    });
  }
};

const post = async (shown: Shown): Promise<void> => {
  await channels();
  await Notifications.scheduleNotificationAsync({
    ...(shown.id === undefined ? {} : { identifier: shown.id }),
    content: {
      title: shown.title,
      body: shown.body,
      data: shown.route === undefined ? {} : { route: shown.route },
      priority: shown.urgent ? Notifications.AndroidNotificationPriority.MAX : Notifications.AndroidNotificationPriority.HIGH,
    },
    trigger: { channelId: shown.channel satisfies Channel },
  });
};

// Android: every FCM data message, in the foreground, in the background or with the app closed. Its only data is
// `c`; one that doesn't open (another key, a newer version, a stranger with the token) shows nothing.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  if (Platform.OS !== "android" || "actionIdentifier" in data) return;
  const shown = androidShown(data, await loadPushKeys());
  if (shown !== null) await post(shown);
});

/** At launch: the background task, and what the app shows while it is open (what the task posted; not the raw data message). */
export const setUpNotifications = (): void => {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const show = (n.request.content.title ?? "") !== "" || (n.request.content.body ?? "") !== "";
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
  if (Platform.OS === "android") {
    void channels();
    void Notifications.registerTaskAsync(TASK);
  }
};

/** Routes the last notification tapped, also the one that launched the app, once: it is cleared once read. */
export const useTappedRoute = (onRoute: (route: Route) => void): void => {
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (response === null || response === undefined) return;
    Notifications.clearLastNotificationResponse();
    const request = response.notification.request;
    const trigger = request.trigger as { payload?: unknown } | null;
    void loadPushKeys().then((keys) => {
      const route = tapRoute(request.content.data, trigger?.payload, keys);
      if (route !== undefined) onRoute(route);
    });
    // Once per response: the screen's callback changes with each render.
  }, [response]);
};
