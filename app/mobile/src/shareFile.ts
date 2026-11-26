// A chat's file handed to iOS's share sheet as itself (its name and type). It is written to a folder of its own under
// the cache: there, the name the hub gave it (`hub.json`, `avatar-….jpg`) never replaces a file the app keeps.
import { getRandomBytes } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { Share } from "react-native";
import type { AttachmentGetOutput } from "./desktop";

export const shareFile = async (a: AttachmentGetOutput): Promise<void> => {
  const folder = new Directory(Paths.cache, "shared", Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, "0")).join(""));
  folder.create({ intermediates: true });
  const file = new File(folder, a.name.replace(/[/\\]/gu, "-").replace(/^\.*$/u, "file"));
  await file.write(a.dataB64, { encoding: "base64" });
  await Share.share({ url: file.uri });
};
