// A chat's file opened on the phone: shown in iOS's own previewer (Quick Look: PDFs, Office files, CSV, Markdown,
// text, code), with Share in its corner; or handed to the share sheet as itself (its name and type), for Share and a
// file Quick Look can't show. It is written to a folder of its own under the cache first: there, the name the hub gave
// it (`hub.json`, `avatar-….jpg`) never replaces a file the app keeps.
import { requireOptionalNativeModule } from "expo";
import { getRandomBytes } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { Share } from "react-native";
import type { AttachmentGetOutput } from "./desktop";

/** Quick Look (modules/quick-look); null in a build from before it, which shares instead. */
const quickLook = requireOptionalNativeModule<{ preview(uri: string): Promise<boolean> }>("FleetdQuickLook");

const onDisk = async (a: AttachmentGetOutput): Promise<string> => {
  const folder = new Directory(Paths.cache, "shared", Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, "0")).join(""));
  folder.create({ intermediates: true });
  const file = new File(folder, a.name.replace(/[/\\]/gu, "-").replace(/^\.*$/u, "file"));
  await file.write(a.dataB64, { encoding: "base64" });
  return file.uri;
};

export const shareFile = async (a: AttachmentGetOutput): Promise<void> => {
  await Share.share({ url: await onDisk(a) });
};

/** Shows the file in Quick Look; one it can't show, or a build without it, goes to the share sheet. */
export const openFile = async (a: AttachmentGetOutput): Promise<void> => {
  const uri = await onDisk(a);
  if (quickLook !== null && (await quickLook.preview(uri))) return;
  await Share.share({ url: uri });
};
