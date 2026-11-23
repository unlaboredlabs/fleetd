// A phone screen's control strip (D652), as plain view data: which of the device's controls show, in which groups and
// order, what each is called in its tooltip, a foldable's states in words, and a typed location read as the hub takes
// it. Only the controls the screen's machine says work there show (session.controls): none is drawn and then refused.
// Pure, so it is unit-tested.

/** A control the strip draws: one of the hub's (contracts ScreenControl) it knows how to show. */
export type StripControl = "rotate_left" | "rotate_right" | "fold" | "home" | "back" | "lock" | "shake" | "appearance" | "location" | "screenshot";

/** The strip's groups, top to bottom: turning and folding it, its buttons, what it senses, and taking its picture. */
const GROUPS: readonly (readonly StripControl[])[] = [["rotate_left", "rotate_right", "fold"], ["home", "back", "lock"], ["shake", "appearance", "location"], ["screenshot"]];

/** Each control's tooltip: what it does, in a word or two. */
export const CONTROL_WORD: Readonly<Record<StripControl, string>> = {
  rotate_left: "Rotate left",
  rotate_right: "Rotate right",
  fold: "Fold",
  home: "Home",
  back: "Back",
  lock: "Lock",
  shake: "Shake",
  appearance: "Dark appearance",
  location: "Location",
  screenshot: "Screenshot",
};

/**
 * The strip's groups for a device: only the controls it takes, each group in its order, empty groups gone. A fold needs
 * its states, and none shows without them.
 */
export const stripOf = (controls: readonly string[], folds: readonly string[] | undefined): StripControl[][] => {
  const has = new Set(controls);
  return GROUPS.map((g) => g.filter((c) => has.has(c) && (c !== "fold" || (folds?.length ?? 0) > 0))).filter((g) => g.length > 0);
};

/** The appearance control's tooltip: what pressing it turns the device to. */
export const appearanceWord = (appearance: string | undefined): string => (appearance === "dark" ? "Light appearance" : "Dark appearance");

/** What pressing the appearance control sets: the other one. */
export const otherAppearance = (appearance: string | undefined): "light" | "dark" => (appearance === "dark" ? "light" : "dark");

/** A foldable's state in words: "half_open" is "Half open". */
export const foldWord = (state: string): string => {
  const words = state.replace(/[_-]+/gu, " ").trim();
  return words === "" ? state : words.charAt(0).toUpperCase() + words.slice(1);
};

/** Places a location can be set to in one press. */
export const PLACES: readonly { readonly name: string; readonly at: string }[] = [
  { name: "Cupertino", at: "37.3349,-122.0090" },
  { name: "New York", at: "40.7128,-74.0060" },
  { name: "London", at: "51.5072,-0.1276" },
  { name: "Tokyo", at: "35.6764,139.6500" },
];

/** A typed location ("51.5, -0.12", or with a space between) as the hub takes it, "lat,lon"; null when it isn't one. */
export const latLon = (text: string): string | null => {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/u.exec(text);
  if (m === null) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return `${String(lat)},${String(lon)}`;
};

/** A screenshot's file name: the device and when, as a screenshot on a Mac is named. */
export const shotName = (device: string, at: Date): string => {
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  return `${device} ${day} at ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}.png`;
};

// The desktop's device toolbar (DeviceRail, W859), T3 Code's order: home and rotate; light or dark, text size and a
// screenshot, the rest behind More; then a Duo's postures. Only what the machine says works shows.

/** A control the toolbar draws beside the strip's: text size. */
export type RailControl = StripControl | "text_size";

/** The toolbar's device groups for a device: its buttons, its look, what's behind More, and a Duo's postures. */
export const railOf = (controls: readonly string[], folds: readonly string[] | undefined) => {
  const has = new Set(controls);
  const only = (list: readonly RailControl[]) => list.filter((c) => has.has(c));
  return {
    buttons: only(["home", "rotate_left"]),
    look: only(["appearance", "text_size", "screenshot"]),
    more: only(["rotate_right", "back", "lock", "shake", "location"]),
    postures: has.has("fold") ? (folds ?? []).filter((f) => f in POSTURE) : [],
  };
};

/** A Duo's postures as people name them, in the toolbar's order. */
export const POSTURE: Readonly<Record<string, string>> = { closed: "Closed", "half-open": "Book", open: "Open", laptop: "Laptop" };

/** Dynamic Type's sizes as `text_size` takes them, smallest first, each in words. */
export const TEXT_SIZES: readonly { readonly value: string; readonly word: string }[] = [
  { value: "extra-small", word: "Extra small" },
  { value: "small", word: "Small" },
  { value: "medium", word: "Medium" },
  { value: "large", word: "Large (default)" },
  { value: "extra-large", word: "Extra large" },
  { value: "extra-extra-large", word: "Extra extra large" },
  { value: "extra-extra-extra-large", word: "Largest" },
  { value: "accessibility-medium", word: "Accessibility medium" },
  { value: "accessibility-large", word: "Accessibility large" },
  { value: "accessibility-extra-large", word: "Accessibility extra large" },
  { value: "accessibility-extra-extra-large", word: "Accessibility extra extra large" },
  { value: "accessibility-extra-extra-extra-large", word: "Accessibility largest" },
];

/** A text size in words; unknown, as it is before its first read. */
export const textSizeWord = (value: string | undefined): string => TEXT_SIZES.find((t) => t.value === value)?.word ?? "Text size";
