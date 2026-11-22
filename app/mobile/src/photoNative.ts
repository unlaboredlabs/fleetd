// expo-image-manipulator for photo.ts, when this build has it. The module is native: a bundle on a build made before it
// (which the runtime version's fingerprint should never let happen) sends photos as the picker gave them.
import { requireOptionalNativeModule } from "expo";
import type { Manipulator } from "./photo";

export const manipulator = (): Manipulator | null => {
  if (requireOptionalNativeModule("ExpoImageManipulator") === null) return null;
  // Required here, not imported: the module asks for its native side as it loads.
  const { ImageManipulator } = require("expo-image-manipulator") as typeof import("expo-image-manipulator");
  return ImageManipulator as unknown as Manipulator;
};
