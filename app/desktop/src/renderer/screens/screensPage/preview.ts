// What the Screens page shows that the hub doesn't send yet, for the design preview (W399) only: where each screen
// runs, a small picture of it (a live one's newest frame, an ended one's last), and the agent's latest step in words.
// Built for real, the hub's browser_sessions rows would carry `machineId` and `doing`, and a page-wide thumbnail feed
// (a frame every few seconds for each live screen on show) would stand in for these pictures.
import checkout from "../../../../fixtures/sessions/media/checkoutApplied.jpg";
import payCode from "../../../../fixtures/sessions/media/payCode.jpg";
import notFound from "../../../../fixtures/sessions/media/notFound.jpg";
import home from "../../../../fixtures/sessions/media/home.jpg";
import mac from "../../../../fixtures/sessions/media/macDesktop.jpg";
import desktop from "../../../../fixtures/sessions/media/linuxDesktop.jpg";
import android from "../../../../fixtures/sessions/media/androidInvoices.jpg";
import table from "../../../../fixtures/sessions/media/tableBooking.jpg";
import checkoutCode from "../../../../fixtures/sessions/media/checkoutCode.jpg";

export interface Extra {
  readonly machine: string;
  readonly thumb?: string;
  readonly doing?: string;
  /** The page it is on, for a browser. */
  readonly site?: string;
}

export const EXTRA: Readonly<Record<string, Extra>> = {
  B68722f97b065412024c7cda6c636fd9a: { machine: "devbox", thumb: checkout, doing: "Clicked “Apply” in the order summary", site: "staging.shop.example.com" },
  B9a63189230ff64d06936e60523503180: { machine: "devbox", thumb: payCode, site: "dashboard.pay.example.com" },
  B7c1e5a9d3f7b1c5e9a3d7f1b5c9e3a7d: { machine: "mac", thumb: mac, doing: "Tapped “Add to cart” in Storefront on iPhone 17" },
  B2d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c: { machine: "buildbox", thumb: desktop, doing: "Ran invoice-preview for October" },
  B9e3c7a1f5d9b3e7c1a5f9d3b7e1c5a9f: { machine: "buildbox", thumb: android, doing: "#31’s build installed" },
  B4a8e2c6f0b4d8a2e6c0f4b8d2a6e0c4b: { machine: "devbox", thumb: table, doing: "Picked 12:30 for two", site: "casalina.example.com" },
  Bf9fa4f882f29b35fe577a1519bf33cba: { machine: "devbox" },
  Bda813e7bb3877f4fca5494357cb97cbf: { machine: "devbox", thumb: notFound, site: "shop.example.com" },
  B1568621fc635262160b1d3c91dbc8977: { machine: "devbox", thumb: home, site: "staging.shop.example.com" },
  B4e36494bac9c5c2b5bc9e430ab097914: { machine: "devbox" },
  Bcabe309c063fd2c81d41bbfdf709c0cf: { machine: "devbox" },
  B6f0b4d8a2e6c0f4b8d2a6e0c4b8f2a6d: { machine: "devbox", thumb: checkoutCode, site: "pay.checkout.example.com" },
  B8b2f6d0a4e8c2f6b0d4a8e2c6f0b4d8a: { machine: "devbox", site: "cp.pt" },
};
