// Every exemption from the DOM checks lives here, with the reason. Keep it short: a growing list means a screen is
// breaking the text rule, and the fix belongs in the screen.

export type CheckId = "overflow" | "overlap" | "edge" | "raw-text" | "drag";

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
    check: "raw-text",
    selector: "[data-version]",
    why: "A nightly is named by its build commit (\"Nightly · Oct 26, 10:56 UTC · 1b563d7\"), and a raw version is there to copy.",
  },
  {
    check: "overlap",
    selector: "[data-app-under-test]",
    why: "Try it shows a project's own app, not the app's text, and the person's feedback pins sit on it on purpose.",
  },
  {
    check: "overflow",
    selector: "[data-text='code']",
    why: "Code scrolls sideways rather than wrapping.",
  },
];
