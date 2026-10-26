// What the Sessions fixture's sessions did, as one timeline each: the share session's steps (its actions, the page
// after each and the frames of its video, which media.ts records), the pricing session's (recorded on a machine without
// ffmpeg, so no video), and the frames the two live sessions stream.
import * as html from "./html.ts";

/** One step: when, what the node logged, the page after it (dom.jsonl), and the frame its video shows from then. */
export interface Step {
  readonly at: number;
  readonly tool: string;
  readonly args: Record<string, string>;
  readonly result?: string;
  readonly url?: string;
  readonly html?: string;
  readonly frame?: string;
}

const LIVE_SHOP = "https://shop.example.com";
const SHOP = "https://staging.shop.example.com";
const ab = (command: string) => ({ command: `agent-browser ${command}` });

/** 40.5 s: the share link 404s, the full path works. */
export const SHARE_MS = 40_500;
export const SHARE: readonly Step[] = [
  { at: 0, tool: "session_start", args: { purpose: "Reproduce the share link 404 on the live shop" }, frame: "blank" },
  { at: 500, tool: "agent-browser", args: ab(`open ${LIVE_SHOP}/products/linen-shirt`), url: `${LIVE_SHOP}/products/linen-shirt`, html: html.shopProduct(0), frame: "product" },
  { at: 3_000, tool: "agent-browser", args: ab("snapshot -i"), result: "- button \"Share\" [ref=e14]\n- button \"Add to cart\" [ref=e12]" },
  { at: 6_000, tool: "agent-browser", args: ab("click @e14"), html: html.shopProduct(0, true), frame: "productShare" },
  { at: 9_000, tool: "agent-browser", args: ab("click '#share-menu .copy-link'") },
  { at: 12_000, tool: "agent-browser", args: ab(`open ${LIVE_SHOP}/s/linen-shirt?ref=share`), url: `${LIVE_SHOP}/s/linen-shirt?ref=share`, html: html.shopNotFound(), frame: "notFound" },
  { at: 17_000, tool: "agent-browser", args: ab("get text h1"), result: "This page isn’t here" },
  { at: 22_000, tool: "agent-browser", args: ab(`open ${LIVE_SHOP}/products/linen-shirt?ref=share`), url: `${LIVE_SHOP}/products/linen-shirt?ref=share`, html: html.shopProduct(0), frame: "product" },
  { at: 28_000, tool: "agent-browser", args: ab("get text h1"), result: "Linen shirt" },
  { at: 33_000, tool: "agent-browser", args: ab("click '#add-to-cart'"), html: html.shopProduct(1), frame: "productAdded" },
  { at: 40_000, tool: "session_end", args: {} },
];

/** 12.5 s; a login filled from 1Password. */
export const PRICING_MS = 12_500;
export const PRICING: readonly Step[] = [
  { at: 0, tool: "session_start", args: { purpose: "Compare the home page copy with the PR’s wording" } },
  { at: 1_000, tool: "agent-browser", args: ab(`open ${SHOP}/account/sign-in`), url: `${SHOP}/account/sign-in`, html: html.shopSignIn(false) },
  // The node logs the reference it was given, never the value; the views never show either.
  { at: 4_000, tool: "fill_credential", args: { ref: "op://Team/Staging shop/password", target: "#email, #password" }, url: `${SHOP}/account/sign-in`, html: html.shopSignIn(true) },
  { at: 6_000, tool: "agent-browser", args: ab("click 'button[type=submit]'"), url: `${SHOP}/`, html: html.shopHome() },
  { at: 9_000, tool: "agent-browser", args: ab("get text '.hero h1'"), result: "Autumn linen" },
  { at: 12_000, tool: "session_end", args: {} },
];

/** The checkout session's live frames, one every 2.2 s, as its agent goes. */
export const CHECKOUT_FRAMES = ["home", "signIn", "signInFilled", "home", "product", "productAdded", "checkout", "checkoutCode", "checkoutApplied"] as const;
/** The payouts session's page: the code it waits on, then (handed back) the dashboard it goes on in. */
export const PAYOUTS_FRAMES = ["payCode", "payDashboard", "payDashboardDownloaded"] as const;
