// The OS side of push.ts, through expo-notifications with the platforms' own push (APNs, FCM), never Expo's service:
// the device token, Android's channels, the background task that opens and posts an Android notification, the
// notification buttons and what they do, the app icon's badge, and what a tap opens. index.ts loads this module first,
// so the task and the button handler exist when the OS starts the app in the background for an FCM data message or a
// button. iOS shows its notifications through the Notification Service Extension instead.
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { webSocketTransport } from "./hub/socket";
import {
  act,
  actOf,
  androidShown,
  CATEGORIES,
  CATEGORY_SUMMARIES,
  CHANNELS,
  opensRoute,
  pushedPayload,
  tapRoute,
  withHub,
  type Acted,
  type Channel,
  type HubLink,
  type PushDeps,
  type Route,
  type Shown,
} from "./push";
import { loadPaired, loadPushDevice, loadPushKeys, pushKeys, savePushDevice } from "./vault";

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
      // The payload too, for its buttons: Android's notification is the app's own, never seen by the relay.
      data: { ...(shown.route === undefined ? {} : { route: shown.route }), payload: shown.payload },
      ...(shown.category === undefined ? {} : { categoryIdentifier: shown.category }),
      ...(shown.badge === undefined ? {} : { badge: shown.badge }),
      priority: shown.urgent ? Notifications.AndroidNotificationPriority.MAX : Notifications.AndroidNotificationPriority.HIGH,
    },
    trigger: { channelId: shown.channel satisfies Channel },
  });
};

const link = async (): Promise<HubLink | null> => {
  const paired = await loadPaired();
  return paired === null ? null : { hub: paired.hub, key: paired.key, transport: webSocketTransport };
};

const newId = (): string => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Responses already acted on: iOS hands a button's response to the listener and keeps it as the last one too. */
const acted = new Set<string>();

/**
 * A button on a notification (Approve, Deny, Reply), with the app in front, behind or started for it: acts with this
 * phone's key, then puts the outcome where the notification was (same id, no sound) and sets the badge. A tap and
 * Review open the app instead (useTappedRoute).
 */
const onResponse = async (response: Notifications.NotificationResponse): Promise<void> => {
  const request = response.notification.request;
  const once = `${request.identifier}/${response.actionIdentifier}/${String(response.notification.date)}`;
  if (opensRoute(response.actionIdentifier, Notifications.DEFAULT_ACTION_IDENTIFIER) || acted.has(once)) return;
  acted.add(once);
  const trigger = request.trigger as { payload?: unknown } | null;
  const payload = pushedPayload(trigger?.payload, request.content.data, await loadPushKeys());
  const a = payload === null ? undefined : actOf(response.actionIdentifier, response.userText, payload);
  const hub = await link();
  if (payload === null || a === undefined || hub === null) return;
  show(request.identifier, await act(a, payload, hub, newId));
};

const show = (identifier: string, { followUp, badge }: Acted): void => {
  if (badge !== undefined) void Notifications.setBadgeCountAsync(badge);
  // A reply sent: gone, as in Messages (Android otherwise keeps it spinning).
  if (followUp === null) return void Notifications.dismissNotificationAsync(identifier);
  void Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: followUp.title,
      body: followUp.body,
      sound: false,
      data: followUp.route === undefined ? {} : { route: followUp.route },
      ...(badge === undefined ? {} : { badge }),
    },
    trigger: Platform.OS === "android" ? { channelId: "quiet" satisfies Channel } : null,
  });
};

/** The buttons, one category at a time: each call reads the registered set and writes it back, so calls at once keep only the last. */
const categories = async (): Promise<void> => {
  for (const [id, actions] of Object.entries(CATEGORIES)) {
    await Notifications.setNotificationCategoryAsync(
      id,
      actions.map((a) => ({ ...a, options: { ...a.options } })),
      { categorySummaryFormat: CATEGORY_SUMMARIES[id as keyof typeof CATEGORIES] },
    );
  }
};

/** The badge again from the hub: as the app goes behind, after the person acted in it. */
const refreshBadge = async (): Promise<void> => {
  const hub = await link();
  if (hub === null) return;
  const r = await withHub(hub, (client) => client.call("push_badge", {}));
  if (r.ok && r.value.ok) await Notifications.setBadgeCountAsync(r.value.output.badge);
};

// Android: every FCM data message, in the foreground, in the background or with the app closed. Its only data is
// `c`; one that doesn't open (another key, a newer version, a stranger with the token) shows nothing. With the app
// behind or closed, a button's response comes here too.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  if (Platform.OS !== "android") return;
  if ("actionIdentifier" in data) return onResponse(data);
  const shown = androidShown(data, await loadPushKeys());
  if (shown !== null) await post(shown);
});

/**
 * At launch: the buttons, the background task, what the app shows while it is open (what the task posted; not the
 * raw data message) and the button handler, also for the response that started the app.
 */
export const setUpNotifications = (): void => {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const show = (n.request.content.title ?? "") !== "" || (n.request.content.body ?? "") !== "";
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show && n.request.content.sound !== null, shouldSetBadge: true };
    },
  });
  void categories();
  Notifications.addNotificationResponseReceivedListener((r) => void onResponse(r));
  const last = Notifications.getLastNotificationResponse();
  if (last !== null && last !== undefined) void onResponse(last);
  AppState.addEventListener("change", (s) => {
    if (s === "background") void refreshBadge();
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
    // A button acts from the notification (onResponse); only a tap or Review opens a screen.
    if (!opensRoute(response.actionIdentifier, Notifications.DEFAULT_ACTION_IDENTIFIER)) return;
    const request = response.notification.request;
    const trigger = request.trigger as { payload?: unknown } | null;
    void loadPushKeys().then((keys) => {
      const route = tapRoute(request.content.data, trigger?.payload, keys);
      if (route !== undefined) onRoute(route);
    });
    // Once per response: the screen's callback changes with each render.
  }, [response]);
};
