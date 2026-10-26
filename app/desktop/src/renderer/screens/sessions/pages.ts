// The design preview's web pages: a made-up shop and a made-up payments dashboard, drawn as 1280×800 SVG so a
// session's frames look like screenshots of a real page without a real site in them, and each page's structure as a
// snapshot would hold it (its elements' roles, names, values and boxes). The broker's frames are JPEG screenshots and
// its snapshots come from the page; these stand in for them until the hub serves sessions.
import type { Box, PageSnapshot, SnapshotNode } from "./model";

const W = 1280;
const H = 800;

type Point = { readonly x: number; readonly y: number };

const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

const text = (x: number, y: number, s: string, size = 16, fill = "#1a1a1a", weight = 400, anchor = "start") =>
  `<text x="${String(x)}" y="${String(y)}" font-size="${String(size)}" font-weight="${String(weight)}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

const rect = (x: number, y: number, w: number, h: number, fill: string, r = 0, stroke?: string) =>
  `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="${String(r)}" fill="${fill}"${stroke === undefined ? "" : ` stroke="${stroke}"`}/>`;

const field = (x: number, y: number, w: number, label: string, value: string) =>
  text(x, y, label, 14, "#555", 500) + rect(x, y + 10, w, 44, "#fff", 6, "#c9c9c4") + (value === "" ? "" : text(x + 14, y + 39, value, 16, "#1a1a1a"));

const button = (x: number, y: number, w: number, label: string, fill: string) => rect(x, y, w, 46, fill, 6) + text(x + w / 2, y + 29, label, 16, "#fff", 600, "middle");

/** The agent's pointer where it acts, with a ring where it clicked. */
const pointer = (at: Point | undefined) =>
  at === undefined
    ? ""
    : `<circle cx="${String(at.x)}" cy="${String(at.y)}" r="16" fill="none" stroke="#1a1a1a" stroke-opacity="0.35" stroke-width="2"/>` +
      `<path transform="translate(${String(at.x)} ${String(at.y)})" d="M0 0 L0 22 L6 17 L10 26 L14 24 L10 15 L18 15 Z" fill="#1a1a1a" stroke="#fff" stroke-width="1.5"/>`;

const svg = (body: string, at?: Point) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(W)} ${String(H)}" font-family="Helvetica, Arial, sans-serif">${rect(0, 0, W, H, "#fff")}${body}${pointer(at)}</svg>`,
  )}`;

// The shop: Linen & Co.
const SHOP = "#24433b";
const shopHead = (cart: number) =>
  rect(0, 0, W, 72, "#f6f4ef") +
  text(48, 45, "Linen & Co.", 24, SHOP, 700) +
  text(860, 44, "Shop", 16, "#333") +
  text(940, 44, "Journal", 16, "#333") +
  text(1040, 44, "Sign in", 16, "#333") +
  text(1140, 44, `Cart (${String(cart)})`, 16, "#333", 600);

const product = (x: number, y: number, name: string, price: string, tone: string) => rect(x, y, 270, 300, tone, 4) + text(x, y + 330, name, 16, "#1a1a1a", 500) + text(x, y + 354, price, 15, "#555");

export const blank = (): string => svg(rect(0, 0, W, H, "#fafafa"));

export const shopHome = (at?: Point): string =>
  svg(
    shopHead(0) +
      rect(48, 104, 1184, 220, "#e9e4d8", 4) +
      text(96, 200, "Autumn linen", 44, SHOP, 700) +
      text(96, 244, "Washed, breathable, made to last.", 20, "#444") +
      product(48, 360, "Linen shirt", "$68.00", "#ddd6c6") +
      product(352, 360, "Linen trousers", "$84.00", "#d4dbd3") +
      product(656, 360, "Overshirt", "$96.00", "#e3d9cf") +
      product(960, 360, "Throw", "$120.00", "#d7d3dc"),
    at,
  );

export const shopSignIn = (filled: boolean, at?: Point): string =>
  svg(
    shopHead(0) +
      text(640, 190, "Sign in to Linen & Co.", 30, "#1a1a1a", 700, "middle") +
      field(440, 250, 400, "Email", filled ? "qa-checkout@acme.test" : "") +
      field(440, 340, 400, "Password", filled ? "••••••••••••" : "") +
      button(440, 440, 400, "Sign in", SHOP) +
      text(640, 530, "Forgot your password?", 14, "#555", 400, "middle"),
    at,
  );

export const shopProduct = (cart: number, at?: Point, share = false): string =>
  svg(
    shopHead(cart) +
      rect(48, 104, 560, 640, "#ddd6c6", 4) +
      text(672, 160, "Linen shirt", 36, "#1a1a1a", 700) +
      text(672, 204, "$68.00", 22, "#333") +
      text(672, 268, "Size", 14, "#555", 500) +
      rect(672, 282, 64, 44, "#fff", 6, "#c9c9c4") +
      text(704, 310, "S", 16, "#333", 500, "middle") +
      rect(748, 282, 64, 44, "#1a1a1a", 6) +
      text(780, 310, "M", 16, "#fff", 600, "middle") +
      rect(824, 282, 64, 44, "#fff", 6, "#c9c9c4") +
      text(856, 310, "L", 16, "#333", 500, "middle") +
      button(672, 360, 360, cart > 0 ? "Added to cart" : "Add to cart", SHOP) +
      text(672, 460, "Washed linen, relaxed fit. Made in Portugal.", 16, "#444") +
      rect(672, 482, 96, 36, "#fff", 6, "#c9c9c4") +
      text(720, 506, "Share", 15, "#333", 500, "middle") +
      (share ? rect(672, 524, 180, 84, "#fff", 8, "#c9c9c4") + text(690, 556, "Copy link", 15, "#1a1a1a") + text(690, 590, "Email", 15, "#1a1a1a") : ""),
    at,
  );

export const shopCheckout = ({ code = "", applied = false }: { code?: string; applied?: boolean }, at?: Point): string => {
  const line = (y: number, l: string, r: string, weight = 400, fill = "#333") => text(760, y, l, 16, fill, weight) + text(1200, y, r, 16, fill, weight, "end");
  return svg(
    shopHead(1) +
      text(48, 140, "Checkout", 30, "#1a1a1a", 700) +
      field(48, 190, 600, "Email", "qa-checkout@acme.test") +
      field(48, 280, 600, "Address", "1 Test Street") +
      field(48, 370, 290, "City", "Lisbon") +
      field(358, 370, 290, "Postcode", "1100-001") +
      button(48, 480, 600, "Place order", SHOP) +
      rect(720, 104, 512, 560, "#f6f4ef", 6) +
      text(760, 150, "Order summary", 20, "#1a1a1a", 700) +
      rect(760, 176, 64, 64, "#ddd6c6", 4) +
      text(840, 204, "Linen shirt · M", 16, "#1a1a1a", 500) +
      text(840, 228, "Qty 1", 14, "#555") +
      text(1200, 204, "$68.00", 16, "#333", 400, "end") +
      field(760, 280, 300, "Discount code", code) +
      rect(1076, 290, 124, 44, "#fff", 6, "#1a1a1a") +
      text(1138, 318, "Apply", 16, "#1a1a1a", 600, "middle") +
      line(400, "Subtotal", "$68.00") +
      (applied ? line(436, "Discount (SAVE10)", "−$6.80", 400, SHOP) : "") +
      line(applied ? 472 : 436, "Shipping", "Free") +
      rect(760, applied ? 500 : 464, 440, 1, "#d8d3c6") +
      line(applied ? 540 : 504, "Total", applied ? "$61.20" : "$68.00", 700, "#1a1a1a"),
    at,
  );
};

export const shopNotFound = (at?: Point): string =>
  svg(
    shopHead(0) +
      text(640, 330, "404", 96, "#d8d3c6", 700, "middle") +
      text(640, 400, "This page isn’t here", 28, "#1a1a1a", 700, "middle") +
      text(640, 440, "The link may be broken, or the page may have moved.", 18, "#555", 400, "middle") +
      button(540, 480, 200, "Back to the shop", SHOP),
    at,
  );

// The payments dashboard: Example Pay.
const PAY = "#3d3dc4";
const payLogo = (x: number, y: number) => rect(x, y - 24, 30, 30, PAY, 8) + text(x + 42, y, "Example Pay", 22, "#1a1a2e", 700);

export const paySignIn = (filled: boolean, at?: Point): string =>
  svg(
    rect(0, 0, W, H, "#f5f6fb") +
      rect(400, 120, 480, 480, "#fff", 12, "#e3e4ee") +
      payLogo(440, 190) +
      text(440, 250, "Sign in to your dashboard", 22, "#1a1a2e", 700) +
      field(440, 290, 400, "Email", filled ? "finance@acme.test" : "") +
      field(440, 380, 400, "Password", filled ? "••••••••••••••" : "") +
      button(440, 480, 400, "Continue", PAY),
    at,
  );

export const payCode = (digits: string, at?: Point): string => {
  let boxes = "";
  for (let i = 0; i < 6; i++) {
    const x = 452 + i * 64;
    boxes += rect(x, 330, 52, 64, "#fff", 8, i === digits.length ? PAY : "#c9cbe0") + text(x + 26, 374, digits[i] ?? "", 28, "#1a1a2e", 600, "middle");
  }
  return svg(
    rect(0, 0, W, H, "#f5f6fb") +
      rect(400, 120, 480, 480, "#fff", 12, "#e3e4ee") +
      payLogo(440, 190) +
      text(440, 250, "Check your phone", 22, "#1a1a2e", 700) +
      text(440, 290, "Enter the 6-digit code we sent to •••• 0142.", 16, "#555") +
      boxes +
      button(440, 440, 400, "Verify", PAY) +
      text(640, 530, "Resend the code", 14, PAY, 500, "middle"),
    at,
  );
};

export const payDashboard = ({ downloaded = false }: { downloaded?: boolean }, at?: Point): string => {
  const row = (y: number, date: string, amount: string, state: string) =>
    rect(300, y - 30, 932, 1, "#e3e4ee") + text(324, y, date, 16, "#333") + text(640, y, amount, 16, "#1a1a2e", 600) + text(900, y, state, 16, "#555");
  return svg(
    rect(0, 0, 252, H, "#f5f6fb") +
      payLogo(32, 56) +
      text(32, 130, "Home", 16, "#555") +
      text(32, 170, "Payments", 16, "#555") +
      rect(20, 192, 212, 36, "#e6e6f7", 6) +
      text(32, 216, "Payouts", 16, PAY, 600) +
      text(32, 262, "Reports", 16, "#555") +
      text(300, 92, "Payouts", 30, "#1a1a2e", 700) +
      text(300, 128, "September 2026", 16, "#555") +
      rect(1052, 64, 180, 44, downloaded ? "#fff" : PAY, 6, downloaded ? "#c9cbe0" : undefined) +
      text(1142, 92, downloaded ? "Downloaded" : "Download CSV", 16, downloaded ? "#555" : "#fff", 600, "middle") +
      text(324, 196, "Date", 14, "#777", 600) +
      text(640, 196, "Amount", 14, "#777", 600) +
      text(900, 196, "Status", 14, "#777", 600) +
      row(250, "Sep 30", "$18,420.00", "Paid") +
      row(310, "Sep 23", "$16,905.50", "Paid") +
      row(370, "Sep 16", "$17,388.10", "Paid") +
      row(430, "Sep 9", "$15,012.75", "Paid") +
      row(490, "Sep 2", "$14,640.00", "Paid"),
    at,
  );
};

// The same pages' structure, as a step's snapshot holds it.
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const n = (depth: number, role: string, name?: string, more: Omit<SnapshotNode, "depth" | "role" | "name"> = {}): SnapshotNode => ({
  depth,
  role,
  ...(name === undefined ? {} : { name }),
  ...more,
});

const shopBanner = (cart: number): SnapshotNode[] => [
  n(0, "banner"),
  n(1, "link", "Linen & Co.", { box: box(48, 22, 150, 30) }),
  n(1, "navigation"),
  n(2, "link", "Shop", { box: box(852, 24, 50, 28) }),
  n(2, "link", "Journal", { box: box(932, 24, 70, 28) }),
  n(2, "link", "Sign in", { box: box(1032, 24, 64, 28) }),
  n(2, "link", `Cart (${String(cart)})`, { box: box(1132, 24, 90, 28) }),
];

const fieldNode = (depth: number, name: string, x: number, y: number, w: number, value: string, secret?: SnapshotNode["secret"]): SnapshotNode =>
  n(depth, "textbox", name, { box: box(x, y + 10, w, 44), ...(secret !== undefined && value !== "" ? { secret } : value === "" ? {} : { value }) });

export const structure = {
  blank: (): SnapshotNode[] => [n(0, "document", undefined, { value: "nothing loaded" })],
  shopHome: (): SnapshotNode[] => [
    ...shopBanner(0),
    n(0, "main"),
    n(1, "heading", "Autumn linen", { box: box(96, 160, 300, 50) }),
    n(1, "paragraph", "Washed, breathable, made to last."),
    n(1, "list", "Products"),
    n(2, "link", "Linen shirt, $68.00", { box: box(48, 360, 270, 360) }),
    n(2, "link", "Linen trousers, $84.00", { box: box(352, 360, 270, 360) }),
    n(2, "link", "Overshirt, $96.00", { box: box(656, 360, 270, 360) }),
    n(2, "link", "Throw, $120.00", { box: box(960, 360, 270, 360) }),
  ],
  shopSignIn: (filled: boolean): SnapshotNode[] => [
    ...shopBanner(0),
    n(0, "main"),
    n(1, "heading", "Sign in to Linen & Co.", { box: box(470, 160, 340, 40) }),
    n(1, "form"),
    fieldNode(2, "Email", 440, 250, 400, filled ? "qa-checkout@acme.test" : ""),
    fieldNode(2, "Password", 440, 340, 400, filled ? "x" : "", "vault"),
    n(2, "button", "Sign in", { box: box(440, 440, 400, 46) }),
    n(1, "link", "Forgot your password?", { box: box(565, 516, 150, 20) }),
  ],
  shopProduct: (cart: number, share = false): SnapshotNode[] => [
    ...shopBanner(cart),
    n(0, "main"),
    n(1, "img", "Linen shirt", { box: box(48, 104, 560, 640) }),
    n(1, "heading", "Linen shirt", { box: box(672, 128, 220, 44) }),
    n(1, "paragraph", "$68.00"),
    n(1, "radiogroup", "Size"),
    n(2, "radio", "S", { box: box(672, 282, 64, 44) }),
    n(2, "radio", "M", { value: "checked", box: box(748, 282, 64, 44) }),
    n(2, "radio", "L", { box: box(824, 282, 64, 44) }),
    n(1, "button", cart > 0 ? "Added to cart" : "Add to cart", { box: box(672, 360, 360, 46) }),
    n(1, "paragraph", "Washed linen, relaxed fit. Made in Portugal."),
    n(1, "button", "Share", { ...(share ? { value: "expanded" } : {}), box: box(672, 482, 96, 36) }),
    ...(share ? [n(1, "menu", "Share"), n(2, "menuitem", "Copy link", { box: box(680, 534, 164, 30) }), n(2, "menuitem", "Email", { box: box(680, 568, 164, 30) })] : []),
  ],
  shopCheckout: ({ code = "", applied = false }: { code?: string; applied?: boolean }): SnapshotNode[] => [
    ...shopBanner(1),
    n(0, "main"),
    n(1, "heading", "Checkout", { box: box(48, 110, 160, 40) }),
    n(1, "form", "Contact and address"),
    fieldNode(2, "Email", 48, 190, 600, "qa-checkout@acme.test"),
    fieldNode(2, "Address", 48, 280, 600, "1 Test Street"),
    fieldNode(2, "City", 48, 370, 290, "Lisbon"),
    fieldNode(2, "Postcode", 358, 370, 290, "1100-001"),
    n(2, "button", "Place order", { box: box(48, 480, 600, 46) }),
    n(1, "complementary", "Order summary", { box: box(720, 104, 512, 560) }),
    n(2, "heading", "Order summary"),
    n(2, "listitem", "Linen shirt · M, Qty 1, $68.00"),
    fieldNode(2, "Discount code", 760, 280, 300, code),
    n(2, "button", "Apply", { box: box(1076, 290, 124, 44) }),
    n(2, "row", "Subtotal", { value: "$68.00" }),
    ...(applied ? [n(2, "row", "Discount (SAVE10)", { value: "−$6.80" })] : []),
    n(2, "row", "Shipping", { value: "Free" }),
    n(2, "row", "Total", { value: applied ? "$61.20" : "$68.00", box: box(760, applied ? 520 : 484, 440, 30) }),
  ],
  shopNotFound: (): SnapshotNode[] => [
    ...shopBanner(0),
    n(0, "main"),
    n(1, "heading", "This page isn’t here", { box: box(480, 372, 320, 40) }),
    n(1, "paragraph", "The link may be broken, or the page may have moved."),
    n(1, "link", "Back to the shop", { box: box(540, 480, 200, 46) }),
  ],
  paySignIn: (filled: boolean): SnapshotNode[] => [
    n(0, "main"),
    n(1, "heading", "Sign in to your dashboard", { box: box(440, 228, 300, 30) }),
    n(1, "form"),
    fieldNode(2, "Email", 440, 290, 400, filled ? "finance@acme.test" : ""),
    fieldNode(2, "Password", 440, 380, 400, filled ? "x" : "", "vault"),
    n(2, "button", "Continue", { box: box(440, 480, 400, 46) }),
  ],
  payCode: (digits: string): SnapshotNode[] => [
    n(0, "main"),
    n(1, "heading", "Check your phone", { box: box(440, 228, 220, 30) }),
    n(1, "paragraph", "Enter the 6-digit code we sent to •••• 0142."),
    fieldNode(1, "6-digit code", 452, 320, 372, digits, "person"),
    n(1, "button", "Verify", { box: box(440, 440, 400, 46) }),
    n(1, "link", "Resend the code", { box: box(580, 516, 120, 20) }),
  ],
  payDashboard: ({ downloaded = false }: { downloaded?: boolean }): SnapshotNode[] => [
    n(0, "navigation"),
    n(1, "link", "Home", { box: box(20, 112, 212, 28) }),
    n(1, "link", "Payments", { box: box(20, 152, 212, 28) }),
    n(1, "link", "Payouts", { value: "current page", box: box(20, 192, 212, 36) }),
    n(1, "link", "Reports", { box: box(20, 244, 212, 28) }),
    n(0, "main"),
    n(1, "heading", "Payouts", { box: box(300, 62, 140, 40) }),
    n(1, "button", downloaded ? "Downloaded" : "Download CSV", { box: box(1052, 64, 180, 44) }),
    n(1, "table", "September 2026", { box: box(300, 170, 932, 340) }),
    n(2, "row", "Sep 30", { value: "$18,420.00 · Paid" }),
    n(2, "row", "Sep 23", { value: "$16,905.50 · Paid" }),
    n(2, "row", "Sep 16", { value: "$17,388.10 · Paid" }),
    n(2, "row", "Sep 9", { value: "$15,012.75 · Paid" }),
    n(2, "row", "Sep 2", { value: "$14,640.00 · Paid" }),
  ],
};

/** A snapshot of `nodes`, the step's targets found by role and name (all of a role, with no name given). */
export const snap = (nodes: readonly SnapshotNode[], ...targets: ReadonlyArray<readonly [string, string?]>): PageSnapshot => ({
  page: { width: W, height: H },
  nodes,
  targets: nodes.flatMap((x, i) => (targets.some(([role, name]) => x.role === role && (name === undefined || x.name === name)) ? [i] : [])),
});
