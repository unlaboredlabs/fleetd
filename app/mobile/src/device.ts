// What the app calls the device it runs on, in what people read: an iPad is an iPad, every other one a phone.
import { Platform } from "react-native";

export const DEVICE: "iPad" | "phone" = Platform.OS === "ios" && Platform.isPad ? "iPad" : "phone";
