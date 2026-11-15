// The browser's own parts for the shell (WebDeps): kept apart from shell.ts so tests drive the shell with fakes.
import { browserTransport } from "./hub";
import { platformOf, type WebDeps } from "./shell";

/** The tab's title, with what waits for the person in front when anything does. */
const TITLE = "fleetd";

const download = (name: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // The download has its bytes once clicked; a minute covers a slow disk.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/** A picture as PNG, the one kind every browser's clipboard takes. */
const png = async (blob: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b === null ? reject(new Error("no PNG")) : resolve(b)), "image/png"));
};

/** What `browserNotify` needs of the browser's Notification; tests give a fake. */
export interface NotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options: { body: string; tag: string }): { onclick: ((this: never, ev: Event) => unknown) | null; close(): void };
}

/**
 * The browser's notifications. Permission is asked only while a person's click is still active (Settings' test):
 * Safari and Firefox ignore or deny an ask made without one, and a later click could no longer bring it back. Asked
 * at once, before any wait, so the click still counts.
 */
export const browserNotify =
  (api: NotificationApi | undefined, clicked: () => boolean, focus: () => void = () => undefined): WebDeps["notify"] =>
  async (title, options, onClick) => {
    if (api === undefined) return false;
    const permission = api.permission === "default" && clicked() ? await api.requestPermission().catch(() => "denied" as const) : api.permission;
    if (permission !== "granted") return false;
    const shown = new api(title, options);
    shown.onclick = () => {
      focus();
      onClick();
      shown.close();
    };
    return true;
  };

export const browserDeps = (version: string): WebDeps => ({
  fetch: (input, init) => window.fetch(input, init),
  transport: browserTransport(),
  origin: window.location.origin,
  here: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
  go: (path) => window.location.assign(path),
  reload: () => window.location.reload(),
  // Not "noopener", which makes open() answer null and hides a blocked tab: the new tab's opener is cut at once instead,
  // before its page loads.
  open: (url, name) => {
    const tab = window.open(url, name ?? "_blank");
    if (tab !== null) tab.opener = null;
    return tab;
  },
  copy: (text) => navigator.clipboard.writeText(text),
  save: download,
  copyImage: async (blob) => navigator.clipboard.write([new ClipboardItem({ "image/png": png(blob) })]),
  notify: browserNotify(
    typeof Notification === "undefined" ? undefined : Notification,
    // A browser without userActivation (older Safari) is asked only when the page has its focus.
    () => ("userActivation" in navigator ? navigator.userActivation.isActive : document.hasFocus()),
    () => window.focus(),
  ),
  setTitle: (count) => {
    document.title = count > 0 ? `(${String(count)}) ${TITLE}` : TITLE;
    // The installed app's icon too, where the browser has badges (not Firefox).
    if ("setAppBadge" in navigator) void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => undefined);
  },
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
  storage: window.localStorage,
  platform: platformOf((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform),
  version,
});
