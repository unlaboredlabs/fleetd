// Every exemption from the DOM checks lives here, with the reason. Keep it short: a growing list means a screen is
// breaking the text rule, and the fix belongs in the screen.

export type CheckId = "overflow" | "overlap" | "edge" | "raw-text";

export interface Allowance {
  check: CheckId;
  // Matched with Element.closest(), so it also covers the element's subtree.
  selector: string;
  why: string;
}

export const allowlist: readonly Allowance[] = [
  {
    check: "raw-text",
    selector: "[data-text='code'], code, pre, kbd, samp, [contenteditable='true']",
    why: "Code views and the composer show text exactly as written.",
  },
  {
    check: "overflow",
    selector: "[data-text='code']",
    why: "Code scrolls sideways rather than wrapping.",
  },
];
