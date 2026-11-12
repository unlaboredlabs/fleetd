// This phone's name, which names the key a hub's /pair makes for it: the one the person gave it, else its kind.
import * as Device from "expo-device";
import { Platform } from "react-native";

export const deviceName = (): string => Device.deviceName ?? (Platform.OS === "ios" ? "iPhone" : "Android phone");
