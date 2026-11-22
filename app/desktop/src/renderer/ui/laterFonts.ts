// Geist's Medium and SemiBold, as faces added from here rather than base.css: the web adds them once its first chat
// has shown (addLaterFonts), so a slow link spends its first seconds on what the chat needs; until then the browser draws
// those weights from Regular, then each takes its own weight in place (display: swap). The desktop adds them before its
// first render, as base.css's faces load (display: block). Each cut by alphabet, as base.css says.
import mediumBasic from "./fonts/Geist-Medium-basic.woff2?url";
import mediumLatin from "./fonts/Geist-Medium-latin.woff2?url";
import mediumMore from "./fonts/Geist-Medium-more.woff2?url";
import semiBoldBasic from "./fonts/Geist-SemiBold-basic.woff2?url";
import semiBoldLatin from "./fonts/Geist-SemiBold-latin.woff2?url";
import semiBoldMore from "./fonts/Geist-SemiBold-more.woff2?url";

const FACES: ReadonlyArray<readonly [weight: string, url: string, unicodeRange: string]> = [
  ["500", mediumBasic, "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["500", mediumLatin, "U+02B0-02BA, U+02BD-02C5, U+02C7-02D9, U+02DB, U+02DD-036F, U+0530-1C7F, U+1C90-1DFF, U+2070-20AB, U+20AD-2121, U+2123-218F, U+2194-2211, U+2213-2214, U+2216-2DDF, U+2E00-A63F, U+A6A0-FEFE, U+FF00-FFFC, U+FFFE-10FFFF"],
  ["500", mediumMore, "U+0100-0130, U+0132-0151, U+0154-02AF, U+0370-052F, U+1C80-1C8F, U+1E00-1FFF, U+2DE0-2DFF, U+A640-A69F"],
  ["600", semiBoldBasic, "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["600", semiBoldLatin, "U+02B0-02BA, U+02BD-02C5, U+02C7-02D9, U+02DB, U+02DD-036F, U+0530-1C7F, U+1C90-1DFF, U+2070-20AB, U+20AD-2121, U+2123-218F, U+2194-2211, U+2213-2214, U+2216-2DDF, U+2E00-A63F, U+A6A0-FEFE, U+FF00-FFFC, U+FFFE-10FFFF"],
  ["600", semiBoldMore, "U+0100-0130, U+0132-0151, U+0154-02AF, U+0370-052F, U+1C80-1C8F, U+1E00-1FFF, U+2DE0-2DFF, U+A640-A69F"],
];

let added = false;

/** Adds the two weights' faces to the page (each file loads when text first uses it); once. */
export const addLaterFonts = (display: "block" | "swap"): void => {
  if (added || typeof FontFace === "undefined" || typeof document === "undefined") return;
  added = true;
  for (const [weight, url, unicodeRange] of FACES) {
    document.fonts.add(new FontFace("Geist", `url("${url}") format("woff2")`, { weight, style: "normal", display, unicodeRange }));
  }
};
