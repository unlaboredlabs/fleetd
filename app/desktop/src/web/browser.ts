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

const notify: WebDeps["notify"] = async (title, options, onClick) => {
  if (typeof Notification === "undefined") return false;
  // Asked only from a person's click (Settings' test) in most browsers; elsewhere a "default" stays as it is.
  const permission = Notification.permission === "default" ? await Notification.requestPermission().catch(() => "denied" as const) : Notification.permission;
  if (permission !== "granted") return false;
  const shown = new Notification(title, options);
  shown.onclick = () => {
    window.focus();
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
  notify,
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
