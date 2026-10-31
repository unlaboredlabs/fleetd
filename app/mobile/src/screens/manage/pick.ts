// A photo for a project's or Navi's icon sheet (IconPicker.tsx): Choose Photo (the library) or Take Photo (the camera);
// one picked or taken goes on to Move and Scale (Photo.tsx).
import * as ImagePicker from "expo-image-picker";
import { Alert, Linking } from "react-native";

export type Picked = { uri: string; width: number; height: number; mime: "image/jpeg" | "image/png" | "image/webp" };

const pickedOf = (a: ImagePicker.ImagePickerAsset): Picked => ({
  uri: a.uri,
  width: a.width,
  height: a.height,
  mime: a.mimeType === "image/png" || a.mimeType === "image/webp" ? a.mimeType : "image/jpeg",
});

/** A photo from the library; null when the person cancels. Compatible: a HEIC comes as a JPEG, which the hub takes. */
export const fromLibrary = async (): Promise<Picked | null> => {
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  const a = r.canceled ? undefined : r.assets[0];
  return a === undefined ? null : pickedOf(a);
};

export const fromCamera = async (): Promise<Picked | null> => {
  const allowed = await ImagePicker.requestCameraPermissionsAsync();
  if (!allowed.granted) {
    Alert.alert("fleetd can't use the camera", "Allow it in Settings › fleetd › Camera.", [
      { text: "Not Now", style: "cancel" },
      { text: "Open Settings", onPress: () => void Linking.openSettings() },
    ]);
    return null;
  }
  try {
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    const a = r.canceled ? undefined : r.assets[0];
    return a === undefined ? null : pickedOf(a);
  } catch {
    Alert.alert("No camera", "This device has no camera to take a photo with.");
    return null;
  }
};
