// The Try it fixture's app under test: #14 of storefront, the Linen & Co. checkout with its copy in German and Dutch,
// drawn as 1280×800 SVG with the Sessions fixture's parts (media.ts renders them to the JPEG frames the preview's
// session streams). In Dutch the pay button wraps onto two lines: what the person marks up.
import { button, field, H, rect, SHOP, svg, text, W } from "../sessions/pages.ts";

export type Lang = "de" | "nl";

const WORDS: Readonly<Record<Lang, Readonly<Record<string, string>>>> = {
  de: { shop: "Shop", journal: "Journal", signIn: "Anmelden", cart: "Warenkorb (1)", title: "Kasse", email: "E-Mail", address: "Adresse", city: "Ort", postcode: "PLZ", back: "Zurück", summary: "Übersicht", subtotal: "Zwischensumme", shipping: "Versand", free: "Kostenlos", total: "Gesamt" },
  nl: { shop: "Winkel", journal: "Journaal", signIn: "Inloggen", cart: "Winkelwagen (1)", title: "Afrekenen", email: "E-mail", address: "Adres", city: "Plaats", postcode: "Postcode", back: "Terug", summary: "Overzicht", subtotal: "Subtotaal", shipping: "Verzending", free: "Gratis", total: "Totaal" },
};

/** The pay button: one line in German; in Dutch its words don't fit, and wrap onto two. */
const pay = (lang: Lang, x: number, y: number, w: number) =>
  lang === "de"
    ? button(x, y, w, "Bestellen und bezahlen", SHOP)
    : rect(x, y, w, 64, SHOP, 6) + text(x + w / 2, y + 27, "Bestelling plaatsen", 16, "#fff", 600, "middle") + text(x + w / 2, y + 47, "en betalen", 16, "#fff", 600, "middle");

/** Linen & Co.'s checkout in `lang`, with the language switch the person flips. */
export const checkout = (lang: Lang): string => {
  const t = WORDS[lang];
  const line = (y: number, l: string, r: string, weight = 400, fill = "#333") => text(760, y, l, 16, fill, weight) + text(1200, y, r, 16, fill, weight, "end");
  const lang_ = (x: number, code: Lang) => (code === lang ? rect(x - 6, 22, 36, 30, "#e7e2d6", 4) + text(x + 12, 43, code.toUpperCase(), 14, "#1a1a1a", 700, "middle") : text(x + 12, 43, code.toUpperCase(), 14, "#555", 500, "middle"));
  return svg(
    rect(0, 0, W, 72, "#f6f4ef") +
      text(48, 45, "Linen & Co.", 24, SHOP, 700) +
      text(700, 44, t["shop"] ?? "", 16, "#333") +
      text(780, 44, t["journal"] ?? "", 16, "#333") +
      text(880, 44, t["signIn"] ?? "", 16, "#333") +
      text(985, 44, t["cart"] ?? "", 16, "#333", 600) +
      lang_(1150, "de") +
      lang_(1196, "nl") +
      text(48, 140, t["title"] ?? "", 30, "#1a1a1a", 700) +
      field(48, 190, 600, t["email"] ?? "", "j.devries@example.com") +
      field(48, 280, 600, t["address"] ?? "", "Prinsengracht 12") +
      field(48, 370, 290, t["city"] ?? "", lang === "de" ? "Berlin" : "Amsterdam") +
      field(358, 370, 290, t["postcode"] ?? "", lang === "de" ? "10115" : "1015 DV") +
      rect(48, 480, 150, 46, "#fff", 6, "#1a1a1a") +
      text(123, 509, t["back"] ?? "", 16, "#1a1a1a", 600, "middle") +
      pay(lang, 438, 480, 210) +
      rect(720, 104, 512, 440, "#f6f4ef", 6) +
      text(760, 150, t["summary"] ?? "", 20, "#1a1a1a", 700) +
      rect(760, 176, 64, 64, "#ddd6c6", 4) +
      text(840, 204, lang === "de" ? "Leinenhemd · M" : "Linnen overhemd · M", 16, "#1a1a1a", 500) +
      text(840, 228, lang === "de" ? "Menge 1" : "Aantal 1", 14, "#555") +
      text(1200, 204, "€68,00", 16, "#333", 400, "end") +
      line(300, t["subtotal"] ?? "", "€68,00") +
      line(336, t["shipping"] ?? "", t["free"] ?? "") +
      rect(760, 364, 440, 1, "#d8d3c6") +
      line(404, t["total"] ?? "", "€68,00", 700, "#1a1a1a") +
      rect(0, H - 1, W, 1, "#fff"),
  );
};

export const PAGES: Readonly<Record<string, string>> = {
  checkoutDe: checkout("de"),
  checkoutNl: checkout("nl"),
};
