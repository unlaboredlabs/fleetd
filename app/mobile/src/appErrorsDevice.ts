// The app's error keeper (appErrors.ts) on the phone: its reports in one small file in the app's documents, written
// before the call returns, so a fatal one is there when the app next starts; the build from the app's own Info.plist and
// the update it runs; and React Native's global handler, which sees what nothing else caught. Left to React Native, a
// fatal JavaScript error ends the app: ExceptionsManager raises it as an Objective-C exception on the TurboModule queue
// (SIGABRT in ObjCTurboModule::performVoidMethodInvocation, the person's 19:18 crash on build 93, which carries no
// trace of the JavaScript's message). Here the app's JavaScript starts over instead (recovers in appErrors.ts).
import Constants from "expo-constants";
import * as Device from "expo-device";
import { File, Paths } from "expo-file-system";
import * as Updates from "expo-updates";
import { Dimensions, Platform } from "react-native";
import { keeper, recovers, type Build } from "./appErrors";

const file = (): File => new File(Paths.document, "app-errors.json");

const build = (): Build => ({
  platform: Platform.OS === "android" ? "android" : "ios",
  build: (Platform.OS === "android" ? String(Constants.platform?.android?.versionCode ?? "") : (Constants.platform?.ios?.buildNumber ?? "")) || "unknown",
  update: Updates.isEmbeddedLaunch ? "embedded" : (Updates.updateId ?? undefined),
  os: Device.osVersion ?? undefined,
  device: Device.modelId ?? undefined,
});

export const appErrors = keeper({
  load: () => {
    const f = file();
    return f.exists ? (JSON.parse(f.textSync()) as unknown) : null;
  },
  save: (pending) => {
    const f = file();
    if (pending.length === 0) {
      if (f.exists) f.delete();
      return;
    }
    f.writeSync(JSON.stringify(pending));
  },
  build,
  window: () => Dimensions.get("window"),
  now: () => Date.now(),
});

/** When the JavaScript last started over after a fatal error (epoch ms), kept across the restart it makes. */
const reloads = (): File => new File(Paths.document, "app-reloaded.json");

const lastReload = (): number | null => {
  try {
    const f = reloads();
    const at = f.exists ? (JSON.parse(f.textSync()) as unknown) : null;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
};

/** When this JavaScript started: a fatal error in its first seconds ends the app rather than start it over again. */
const STARTED_MS = Date.now();

let installed = false;

/**
 * Keeps whatever reaches React Native's global handler (an error nothing caught, fatal or not), report on disk first.
 * A fatal one starts the app's JavaScript over where it may (recovers), else is handed on, and ends the app as before.
 */
export const catchUncaught = (): void => {
  if (installed) return;
  installed = true;
  const before = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: unknown, fatal?: boolean) => {
    try {
      appErrors.note(error, { fatal: fatal === true });
    } catch {
      // The report mustn't stand in the way of what comes after it.
    }
    const now = Date.now();
    if (fatal === true && recovers(STARTED_MS, lastReload(), now)) {
      try {
        reloads().writeSync(JSON.stringify(now));
        Updates.reloadAsync().catch(() => before(error, fatal));
        return;
      } catch {
        // Nowhere to note it, or no reload: the app ends, as without this.
      }
    }
    before(error, fatal);
  });
};
