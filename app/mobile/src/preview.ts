// Share links on the phone: a chat's preview card and Settings › Share links open one signed in. The workspace gives a
// one-time way in (`share_link_open`) and the in-app browser opens it, so the preview's cookie stays with that page.
// A share link's sign-in page sends a browser that isn't signed in here with `fleetd://preview?url=<the link>`.
import * as WebBrowser from "expo-web-browser";
import { Alert } from "react-native";
import type { Session } from "./session";

export { previewOf, untilWords } from "./previewLink";

/** Opens link `name` signed in, at `to`; says why not when the workspace refuses. */
export async function openPreview(session: Session, name: string, to = "/"): Promise<void> {
  const got = await session.call("share_link_open", { name, ...(to === "/" ? {} : { to }) });
  if (!got.ok) return void Alert.alert("The preview didn't open", got.error.fix === undefined ? got.error.message : `${got.error.message} ${got.error.fix}`);
  await WebBrowser.openBrowserAsync(got.output.url).catch(() => undefined);
}
