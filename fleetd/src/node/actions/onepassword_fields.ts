// A 1Password item read for import as fleetd's vault takes it, with nothing of the machine's: which kind its category
// becomes (`importKind`) and the fields of that kind (`importedFields`), a card's expiry read by `expiry`
// (../browser/logins.ts). The node seals them to the hub (./calls.ts vault_import_read); a service with no node does
// the same with an item its box's helper read.
import type { VaultImportedFields, VaultKind } from "../../shared/contracts.ts";
import { expiry } from "../browser/logins.ts";
import type { ReadItem } from "./onepassword_helper.ts";

export { expiry };
export type { ReadItem, VaultImportedFields, VaultKind };

/** What a 1Password category becomes in fleetd's vault; none for those it doesn't import. */
export function importKind(category: string): VaultKind | undefined {
  if (category === "Login" || category === "Password") return "login";
  if (category === "CreditCard") return "card";
  if (category === "Identity") return "address";
  return undefined;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");
const hostOfSite = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

/** An item read for import as the vault takes it (vault.rs `VaultImportedFields`): its title, its websites' hosts,
 * and the fields of its kind. Empty fields are left out. */
export function importedFields(item: ReadItem): VaultImportedFields {
  const fields = item.fields;
  const by = (ids: string[], types: string[], titles: RegExp) =>
    text(
      (fields.find((f) => ids.includes(text(f.id))) ?? fields.find((f) => types.includes(text(f.type))) ?? fields.find((f) => titles.test(text(f.title))))
        ?.value,
    );
  const some = <T extends Record<string, string>>(o: T): T | undefined => {
    const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "")) as T;
    return Object.keys(kept).length ? kept : undefined;
  };
  const sites = [...new Set(item.sites.map(hostOfSite).filter((h): h is string => h !== undefined))];
  const out: VaultImportedFields = { title: item.title, ...(sites.length ? { sites } : {}) };
  const kind = importKind(item.category);
  if (kind === "login") {
    const login = some({
      username: by(["username"], [], /user ?name|e-?mail|login/i),
      password: by(["password"], [], /password/i),
      totp: by([], ["Totp"], /one-time|otp|totp/i),
      notes: text(item.notes),
    });
    if (login) out.login = login;
  } else if (kind === "card") {
    const expires = expiry(by(["expiry"], ["MonthYear"], /expir/i));
    const card = some({
      number: by(["ccnum", "number"], ["CreditCardNumber"], /number/i).replace(/[^0-9]/g, ""),
      month: expires?.[0] ?? "",
      year: expires?.[1] ?? "",
      cvc: by(["cvv"], [], /verification|cvv|cvc|security code/i),
      name: by(["cardholder"], [], /cardholder|name on card/i),
    });
    if (card) out.card = card;
  } else if (kind === "address") {
    const at = fields.find((f) => text(f.type) === "Address")?.details ?? {};
    const street = text(at.street).split("\n");
    const name = [by(["firstname"], [], /first name/i), by(["lastname"], [], /last name/i)].filter(Boolean).join(" ");
    const address = some({
      name,
      organization: by(["company"], [], /company|organi[sz]ation/i),
      line1: street[0] ?? "",
      line2: street.slice(1).join(", "),
      city: text(at.city),
      region: text(at.state),
      postalCode: text(at.zip),
      country: text(at.country).toUpperCase(),
      phone: by(["defphone", "cellphone", "homephone"], ["Phone"], /phone/i),
      email: by(["email"], ["Email"], /e-?mail/i),
    });
    if (address) out.address = address;
  }
  return out;
}
