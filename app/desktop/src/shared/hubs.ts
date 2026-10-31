// The hubs this app is paired with: each under a label the person picks, in free text, and an
// optional colour that only tells the groups apart. Shared by main (which keeps the list) and the renderer.

/** A hub's id in this app: `hub` for the first (today's files), a short random one for each added later. */
export type HubId = string;

/** The first hub: its key and cache keep the file names the app had before it paired with several. */
export const FIRST_HUB: HubId = "hub";

export const HUB_ID = /^[a-z0-9]{1,16}$/u;

/** Named swatches, so a colour reads in light and dark; it marks a group, never a state. */
export const HUB_COLORS = ["blue", "green", "amber", "rose", "violet", "slate"] as const;
export type HubColor = (typeof HUB_COLORS)[number];

export const LABEL_MAX = 40;

export interface HubEntry {
  readonly id: HubId;
  /** As the person typed it: "Personal", "Acme", "Side project". Never empty. */
  readonly label: string;
  readonly color?: HubColor | undefined;
  /** Something the person should know about this hub's entry, e.g. that it was found again after the list was lost. */
  readonly note?: string | undefined;
}

/** A label as typed, trimmed and with its runs of space made one; null when nothing is left or it's too long. */
export const cleanLabel = (typed: string): string | null => {
  const label = typed.trim().replace(/\s+/gu, " ");
  return label === "" || label.length > LABEL_MAX ? null : label;
};

/** A hub's label until the person picks one: its host name ("devbox"), else its address. */
export const defaultLabel = (url: string): string => {
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(url) ? url : `http://${url}`).hostname;
    // A tailnet name's first part is the machine.
    const first = /^\d+\.\d+\.\d+\.\d+$/u.test(host) || host.startsWith("[") ? host : (host.split(".")[0] ?? host);
    return cleanLabel(first) ?? cleanLabel(url.slice(0, LABEL_MAX)) ?? "Hub";
  } catch {
    return cleanLabel(url.slice(0, LABEL_MAX)) ?? "Hub";
  }
};

/** Where a pairing goes: into a hub already listed (a new key for it), or a new hub under a label. */
export type PairTarget = { readonly hub: HubId } | { readonly label: string; readonly color?: HubColor | undefined };
