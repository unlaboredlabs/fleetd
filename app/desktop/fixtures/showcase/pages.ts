// The showcase's screens (media.ts renders them to the JPEG frames fixtures/showcase streams): Linen & Co.'s web shop
// in a browser, drawn as 1280×800 SVG with the Sessions fixture's parts, and its iPhone app on a simulator, drawn as a
// 390×844 phone screen: the simulator booting, its home screen, the app's shop, its cart asking you to sign in, the
// sign-in, the code it texts (filled in a digit at a time by the person who took over) and the saved cart, back from
// the web.
import { button, rect, SHOP, shopProduct, shopSignIn, svg, text } from "../sessions/pages.ts";

type Point = { readonly x: number; readonly y: number };

export const PHONE_W = 390;
export const PHONE_H = 844;
/** A phone frame's pixels, as the simulator's screen streams them: 480 wide, at the phone's shape. */
export const PHONE_FRAME = { width: 480, height: Math.round((480 * PHONE_H) / PHONE_W) };

// ---- the web shop ----

/** The web cart, signed in: the shirt the agent added, saved to the account. */
const shopCart = (): string =>
  svg(
    rect(0, 0, 1280, 72, "#f6f4ef") +
      text(48, 45, "Linen & Co.", 24, SHOP, 700) +
      text(860, 44, "Shop", 16, "#333") +
      text(940, 44, "Journal", 16, "#333") +
      text(1020, 44, "qa-shopper", 16, "#333") +
      text(1140, 44, "Cart (1)", 16, "#333", 600) +
      text(48, 150, "Your cart", 32, "#1a1a1a", 700) +
      rect(48, 178, 640, 44, "#e8efe9", 6) +
      text(68, 206, "Saved to your account, so it follows you to any device.", 16, SHOP, 600) +
      rect(48, 250, 120, 120, "#ddd6c6", 4) +
      text(192, 284, "Linen shirt", 20, "#1a1a1a", 600) +
      text(192, 314, "Size M · Qty 1", 16, "#555") +
      text(688, 284, "$68.00", 18, "#333", 400, "end") +
      rect(48, 400, 640, 1, "#d8d3c6") +
      text(48, 444, "Subtotal", 18, "#1a1a1a", 600) +
      text(688, 444, "$68.00", 18, "#1a1a1a", 600, "end") +
      button(48, 480, 640, "Check out", SHOP),
  );

// ---- the phone ----

const phone = (body: string, dark = false, tap?: Point) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(PHONE_W)} ${String(PHONE_H)}" font-family="Helvetica, Arial, sans-serif">${rect(0, 0, PHONE_W, PHONE_H, dark ? "#000" : "#fff")}${body}${status(dark)}${
      tap === undefined ? "" : `<circle cx="${String(tap.x)}" cy="${String(tap.y)}" r="22" fill="#1a1a1a" fill-opacity="0.18" stroke="#1a1a1a" stroke-opacity="0.35" stroke-width="2"/>`
    }</svg>`,
  )}`;

/** The status bar: the time, and the signal and battery as plain shapes. */
const status = (light: boolean) => {
  const ink = light ? "#fff" : "#1a1a1a";
  return text(34, 34, "9:41", 16, ink, 600) + rect(300, 22, 18, 10, ink, 2) + rect(326, 21, 28, 13, "none", 4, ink) + rect(329, 24, 20, 7, ink, 2);
};

const boot = (progress: number) => phone(rect(135, 400, 120, 4, "#333", 2) + rect(135, 400, 120 * progress, 4, "#eee", 2), true);

const icon = (x: number, y: number, fill: string, label: string, mark = "") =>
  rect(x, y, 62, 62, fill, 15) + (mark === "" ? "" : text(x + 31, y + 40, mark, 22, "#fff", 700, "middle")) + text(x + 31, y + 80, label, 12, "#fff", 500, "middle");

const home = (tap?: Point) => {
  const cols = [28, 112, 196, 280];
  const row = (y: number, apps: ReadonlyArray<readonly [string, string, string?]>) => apps.map(([fill, label, mark], i) => icon(cols[i] ?? 0, y, fill, label, mark)).join("");
  return phone(
    rect(0, 0, PHONE_W, PHONE_H, "#5b7a8c") +
      rect(0, 420, PHONE_W, 424, "#4b6878") +
      row(80, [[SHOP, "Linen", "L"], ["#3f8fd9", "Mail"], ["#f0b23a", "Notes"], ["#7a7a80", "Settings"]]) +
      row(186, [["#34a35a", "Maps"], ["#e0574f", "Calendar"], ["#8a63d2", "Podcasts"], ["#2fb5a8", "Health"]]) +
      rect(16, 730, 358, 92, "#6f8c9c", 30) +
      [36, 120, 204, 288].map((x, i) => rect(x, 745, 62, 62, ["#3fae5a", "#3f8fd9", "#f2f2f2", "#f0b23a"][i] ?? "#fff", 15)).join(""),
    true,
    tap,
  );
};

/** The app's tab bar, with the cart's count. */
const tabs = (on: "shop" | "cart", cart: number) =>
  rect(0, 770, PHONE_W, 1, "#e2ded4") +
  rect(0, 771, PHONE_W, 73, "#f6f4ef") +
  (
    [
      [49, "Shop", "shop"],
      [146, "Search", "search"],
      [244, "Cart", "cart"],
      [341, "Account", "account"],
    ] as const
  )
    .map(([x, label, id]) => rect(x - 11, 786, 22, 22, id === on ? SHOP : "#b9b4a8", 6) + text(x, 826, label, 12, id === on ? SHOP : "#777", id === on ? 700 : 500, "middle"))
    .join("") +
  (cart > 0 ? rect(252, 778, 20, 20, "#c2410c", 10) + text(262, 793, String(cart), 12, "#fff", 700, "middle") : "");

const appHead = (title: string) => rect(0, 0, PHONE_W, 108, "#f6f4ef") + text(24, 92, title, 28, SHOP, 700);

const appHome = (tap?: Point) =>
  phone(
    appHead("Linen & Co.") +
      rect(20, 128, 350, 150, "#e9e4d8", 10) +
      text(40, 200, "Autumn linen", 26, SHOP, 700) +
      text(40, 230, "Washed, breathable, made to last.", 14, "#444") +
      [
        [20, 300, "Linen shirt", "$68", "#ddd6c6"],
        [200, 300, "Trousers", "$84", "#d4dbd3"],
        [20, 520, "Overshirt", "$96", "#e3d9cf"],
        [200, 520, "Throw", "$120", "#d7d3dc"],
      ]
        .map(([x, y, name, price, tone]) => rect(x as number, y as number, 170, 170, tone as string, 8) + text(x as number, (y as number) + 192, name as string, 15, "#1a1a1a", 600) + text(x as number, (y as number) + 212, price as string, 13, "#555"))
        .join("") +
      tabs("shop", 0),
    false,
    tap,
  );

const appSignedOut = (tap?: Point) =>
  phone(
    appHead("Cart") +
      text(195, 330, "Your cart is empty here", 20, "#1a1a1a", 700, "middle") +
      text(195, 362, "Sign in to pick up the cart", 15, "#555", 400, "middle") +
      text(195, 384, "you saved on the web.", 15, "#555", 400, "middle") +
      rect(45, 420, 300, 50, SHOP, 10) +
      text(195, 451, "Sign in", 17, "#fff", 600, "middle") +
      tabs("cart", 0),
    false,
    tap,
  );

const appField = (y: number, label: string, value: string) => text(30, y, label, 13, "#555", 600) + rect(30, y + 10, 330, 48, "#fff", 10, "#c9c9c4") + text(46, y + 41, value, 16, "#1a1a1a");

const appSignIn = (tap?: Point) =>
  phone(appHead("Sign in") + appField(160, "Email", "qa-shopper@example.com") + appField(250, "Password", "••••••••••••") + rect(30, 350, 330, 50, SHOP, 10) + text(195, 381, "Continue", 17, "#fff", 600, "middle"), false, tap);

const appCode = (digits: string) => {
  let boxes = "";
  for (let i = 0; i < 6; i++) {
    const x = 30 + i * 56;
    boxes += rect(x, 250, 48, 60, "#fff", 10, i === digits.length ? SHOP : "#c9c9c4") + text(x + 24, 291, digits[i] ?? "", 26, "#1a1a1a", 600, "middle");
  }
  return phone(
    appHead("Check your phone") +
      text(30, 160, "We texted a 6-digit code to", 16, "#444") +
      text(30, 184, "•••• 0142. Enter it to sign in.", 16, "#444") +
      boxes +
      rect(30, 350, 330, 50, digits.length === 6 ? SHOP : "#b9b4a8", 10) +
      text(195, 381, "Verify", 17, "#fff", 600, "middle"),
  );
};

const appCart = () =>
  phone(
    appHead("Cart") +
      rect(20, 128, 350, 48, "#e8efe9", 10) +
      text(36, 158, "Saved from your visit on the web", 14, SHOP, 600) +
      rect(20, 200, 96, 96, "#ddd6c6", 8) +
      text(132, 230, "Linen shirt", 17, "#1a1a1a", 600) +
      text(132, 254, "Size M · Qty 1", 14, "#555") +
      text(132, 282, "$68.00", 15, "#333") +
      rect(20, 324, 350, 1, "#e2ded4") +
      text(20, 362, "Subtotal", 16, "#1a1a1a", 600) +
      text(370, 362, "$68.00", 16, "#1a1a1a", 600, "end") +
      rect(20, 390, 350, 50, SHOP, 10) +
      text(195, 421, "Check out", 17, "#fff", 600, "middle") +
      tabs("cart", 1),
  );

export const WEB: Readonly<Record<string, string>> = {
  webSignIn: shopSignIn(true, { x: 640, y: 463 }),
  webProduct: shopProduct(0),
  webAdded: shopProduct(1, { x: 852, y: 383 }),
  webCart: shopCart(),
};

export const PHONE: Readonly<Record<string, string>> = {
  boot1: boot(0.35),
  boot2: boot(0.9),
  home: home({ x: 59, y: 111 }),
  appHome: appHome({ x: 244, y: 797 }),
  appSignedOut: appSignedOut({ x: 195, y: 445 }),
  appSignIn: appSignIn({ x: 195, y: 375 }),
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((n) => [`appCode${String(n)}`, appCode("418093".slice(0, n))])),
  appCart: appCart(),
};

/** The code the person types on the phone, a digit a frame. */
export const CODE = "418093";
