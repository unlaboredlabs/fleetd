// The Sessions fixture's web pages: a made-up shop and a made-up payments dashboard, drawn as 1280×800 SVG so a
// session's frames and video look like a real page's without a real site in them (media.ts renders them to the JPEG
// frames and the WebM the fixture serves), and the same pages as the HTML a step's DOM snapshot holds (html.ts).

export const W = 1280;
export const H = 800;

type Point = { readonly x: number; readonly y: number };

const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

export const text = (x: number, y: number, s: string, size = 16, fill = "#1a1a1a", weight = 400, anchor = "start") =>
  `<text x="${String(x)}" y="${String(y)}" font-size="${String(size)}" font-weight="${String(weight)}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

export const rect = (x: number, y: number, w: number, h: number, fill: string, r = 0, stroke?: string) =>
  `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="${String(r)}" fill="${fill}"${stroke === undefined ? "" : ` stroke="${stroke}"`}/>`;

export const field = (x: number, y: number, w: number, label: string, value: string) =>
  text(x, y, label, 14, "#555", 500) + rect(x, y + 10, w, 44, "#fff", 6, "#c9c9c4") + (value === "" ? "" : text(x + 14, y + 39, value, 16, "#1a1a1a"));

export const button = (x: number, y: number, w: number, label: string, fill: string) => rect(x, y, w, 46, fill, 6) + text(x + w / 2, y + 29, label, 16, "#fff", 600, "middle");

/** The agent's pointer where it acts, with a ring where it clicked. */
const pointer = (at: Point | undefined) =>
  at === undefined
    ? ""
    : `<circle cx="${String(at.x)}" cy="${String(at.y)}" r="16" fill="none" stroke="#1a1a1a" stroke-opacity="0.35" stroke-width="2"/>` +
      `<path transform="translate(${String(at.x)} ${String(at.y)})" d="M0 0 L0 22 L6 17 L10 26 L14 24 L10 15 L18 15 Z" fill="#1a1a1a" stroke="#fff" stroke-width="1.5"/>`;

export const svg = (body: string, at?: Point) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(W)} ${String(H)}" font-family="Helvetica, Arial, sans-serif">${rect(0, 0, W, H, "#fff")}${body}${pointer(at)}</svg>`,
  )}`;

// The shop: Linen & Co.
export const SHOP = "#24433b";
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
      field(440, 250, 400, "Email", filled ? "qa-checkout" : "") +
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
      field(48, 190, 600, "Email", "qa-checkout") +
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
      field(440, 290, 400, "Email", filled ? "finance" : "") +
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
