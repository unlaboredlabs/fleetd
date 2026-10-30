// Its picture's action sheet on a project's or Navi's screen, as a contact's in iOS: Choose Photo (the library), Take
// Photo (the camera), and Remove Photo once it has one; a photo picked or taken goes on to Move and Scale (Photo.tsx).
import * as ImagePicker from "expo-image-picker";
import { ActionSheetIOS, Alert, Linking, Platform } from "react-native";
import { haptics } from "../../ui/haptics";

export type Picked = { uri: string; width: number; height: number; mime: "image/jpeg" | "image/png" | "image/webp" };

const pickedOf = (a: ImagePicker.ImagePickerAsset): Picked => ({
  uri: a.uri,
  width: a.width,
  height: a.height,
  mime: a.mimeType === "image/png" || a.mimeType === "image/webp" ? a.mimeType : "image/jpeg",
});

/** A photo from the library; null when the person cancels. Compatible: a HEIC comes as a JPEG, which the hub takes. */
const fromLibrary = async (): Promise<Picked | null> => {
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  const a = r.canceled ? undefined : r.assets[0];
  return a === undefined ? null : pickedOf(a);
};

const fromCamera = async (): Promise<Picked | null> => {
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

/** The sheet: `onPicked` hears a photo to move and scale, `onRemove` that the picture goes. */
export const pictureSheet = (o: { title: string; has: boolean; onPicked: (p: Picked) => void; onRemove: () => void }): void => {
  haptics.tap();
  const choose = () => void fromLibrary().then((p) => p !== null && o.onPicked(p));
  const take = () => void fromCamera().then((p) => p !== null && o.onPicked(p));
  if (Platform.OS === "ios") {
    const options = ["Choose Photo", "Take Photo", ...(o.has ? ["Remove Photo"] : []), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: o.title, options, cancelButtonIndex: options.length - 1, ...(o.has ? { destructiveButtonIndex: 2 } : {}) },
      (i) => {
        if (i === 0) choose();
        else if (i === 1) take();
        else if (i === 2 && o.has) o.onRemove();
      },
    );
    return;
  }
  Alert.alert(o.title, undefined, [
    { text: "Choose Photo", onPress: choose },
    { text: "Take Photo", onPress: take },
    ...(o.has ? [{ text: "Remove Photo", style: "destructive" as const, onPress: o.onRemove }] : []),
    { text: "Cancel", style: "cancel" },
  ]);
};
