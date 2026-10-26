// The app under test in the preview: storefront's checkout as #14 builds it, on the web and in the Android app. It is
// the project's own app, not fleetd's, so it keeps its own look in either theme. Sizes are in container units, so the
// page lays out as at 800 px wide whatever the frame's size. The person drives it: the language, Pay and Back work.
import { ChevronLeft, CreditCard, ShoppingBag } from "lucide-react";
import { drive, type AppState, type Target } from "./preview";
import s from "./shop.module.css";

const WORDS = {
  de: {
    cart: "Warenkorb",
    items: ["Leinenhemd, Salbei", "Socken, 3 Paar"],
    sizes: ["Größe M", "Einheitsgröße"],
    subtotal: "Zwischensumme",
    shipping: "Versand",
    free: "kostenlos",
    total: "Gesamt",
    pay: "Zahlungspflichtig bestellen",
    back: "Zurück zum Warenkorb",
    payTitle: "Bezahlen",
    card: "Karte",
    thanks: "Danke für deine Bestellung",
    note: "Inkl. MwSt.",
  },
  nl: {
    cart: "Winkelwagen",
    items: ["Linnen overhemd, salie", "Sokken, 3 paar"],
    sizes: ["Maat M", "One size"],
    subtotal: "Subtotaal",
    shipping: "Verzending",
    free: "gratis",
    total: "Totaal",
    pay: "Bestelling plaatsen en betalen",
    back: "Terug naar winkelwagen",
    payTitle: "Betalen",
    card: "Kaart",
    thanks: "Bedankt voor je bestelling",
    note: "Incl. btw",
  },
} as const;

const PRICES = ["€ 69,00", "€ 18,00"] as const;

function Lang({ target, app }: { target: Target; app: AppState }) {
  return (
    <span className={s.lang}>
      {(["de", "nl"] as const).map((l) => (
        <button key={l} type="button" className={s.langOption} aria-pressed={app.lang === l} onClick={() => drive(target, { lang: l })}>
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}

/** The web checkout at its URL, 16:10. */
export function ShopPage({ app }: { app: AppState }) {
  const w = WORDS[app.lang];
  return (
    <div className={s.page} data-lang={app.lang}>
      <header className={s.top}>
        <span className={s.brand}>
          <ShoppingBag aria-hidden className={s.brandIcon} />
          acme
        </span>
        <span className={s.crumbs}>{app.screen === "cart" ? w.cart : w.payTitle}</span>
        <Lang target="web" app={app} />
      </header>
      {app.screen === "thanks" ? (
        <div className={s.thanks}>{w.thanks}</div>
      ) : (
        <div className={s.columns}>
          <section className={s.items}>
            <h1 className={s.h1}>{app.screen === "cart" ? w.cart : w.payTitle}</h1>
            {app.screen === "cart" ? (
              w.items.map((item, i) => (
                <div key={item} className={s.item}>
                  <span className={s.thumb} data-n={i} aria-hidden />
                  <span className={s.itemWords}>
                    <span className={s.itemName}>{item}</span>
                    <span className={s.itemMeta}>{w.sizes[i]}</span>
                  </span>
                  <span className={s.price}>{PRICES[i]}</span>
                </div>
              ))
            ) : (
              <div className={s.cardField}>
                <CreditCard aria-hidden className={s.cardIcon} />
                {w.card} · 4242 4242 4242 4242
              </div>
            )}
          </section>
          <aside className={s.summary}>
            <div className={s.sumRow}>
              <span>{w.subtotal}</span>
              <span>€ 87,00</span>
            </div>
            <div className={s.sumRow}>
              <span>{w.shipping}</span>
              <span>{w.free}</span>
            </div>
            <div className={s.sumTotal}>
              <span>{w.total}</span>
              <span>€ 87,00</span>
            </div>
            <span className={s.vat}>{w.note}</span>
            <button type="button" className={s.pay} onClick={() => drive("web", { screen: app.screen === "cart" ? "pay" : "thanks" })}>
              {w.pay}
            </button>
            <button type="button" className={s.back} onClick={() => drive("web", { screen: "cart" })}>
              {w.back}
            </button>
          </aside>
        </div>
      )}
    </div>
  );
}

/** The Android app's checkout, inside the emulator's screen. */
export function ShopApp({ app }: { app: AppState }) {
  const w = WORDS[app.lang];
  return (
    <div className={s.app} data-lang={app.lang}>
      <div className={s.status} aria-hidden>
        <span>9:41</span>
        <span className={s.statusIcons}>▾ ▮</span>
      </div>
      <header className={s.appBar}>
        {app.screen !== "cart" ? (
          <button type="button" className={s.appBack} aria-label={w.back} onClick={() => drive("android", { screen: "cart" })}>
            <ChevronLeft aria-hidden />
          </button>
        ) : null}
        <span className={s.appTitle}>{app.screen === "pay" ? w.payTitle : app.screen === "thanks" ? "acme" : w.cart}</span>
        <Lang target="android" app={app} />
      </header>
      {app.screen === "thanks" ? (
        <div className={s.appThanks}>{w.thanks}</div>
      ) : (
        <>
          <div className={s.appList}>
            {app.screen === "cart" ? (
              w.items.map((item, i) => (
                <div key={item} className={s.appItem}>
                  <span className={s.appThumb} data-n={i} aria-hidden />
                  <span className={s.itemWords}>
                    <span className={s.appItemName}>{item}</span>
                    <span className={s.appMeta}>{w.sizes[i]}</span>
                  </span>
                  <span className={s.appPrice}>{PRICES[i]}</span>
                </div>
              ))
            ) : (
              <div className={s.appCard}>
                <CreditCard aria-hidden className={s.cardIcon} />
                •••• 4242
              </div>
            )}
          </div>
          <div className={s.appFoot}>
            <div className={s.appTotal}>
              <span>{w.total}</span>
              <span>€ 87,00</span>
            </div>
            <button type="button" className={s.appPay} onClick={() => drive("android", { screen: app.screen === "cart" ? "pay" : "thanks" })}>
              {w.pay}
            </button>
          </div>
        </>
      )}
      <div className={s.gesture} aria-hidden />
    </div>
  );
}
