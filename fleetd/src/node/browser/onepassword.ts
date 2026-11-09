// Logins from 1Password, filled without the agent seeing them. The node
// resolves an `op://` reference with the SDK helper (../actions/onepassword.ts, the Rust node's own script) and a
// service account token: the project's or order's secret variable OP_SERVICE_ACCOUNT_TOKEN, else the token the person
// whose work it is saved. The token never reaches an agent's environment. Each session keeps what it resolved (not
// one-time codes, which change every 30 s) and backs off when 1Password rate-limits the token. The same helper reads a
// Credit Card item's details for an approved purchase only (cards.ts), and an identity field for an approved secure
// input (secure_input.ts).
import { OnePassword, OnePasswordError } from "../actions/onepassword.ts";

export { TOKEN_ENV } from "../actions/onepassword.ts";

/** Tries after a rate limit, and the first wait (doubled each time). */
const RATE_LIMIT_TRIES = 3;
export const RATE_LIMIT_WAIT_MS = 2_000;
/** After the tries ran out on a rate limit, the session asks 1Password nothing for this long: a loop of fills must
 * not use up the account's daily reads, which every machine shares. */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

/** A resolved reference: its value, and the item's websites for the origin check. */
export type Credential = { value: string; urls: string[] };

/** A Credit Card item's details. `month` is two digits, `year` four. */
export type Card = { number: string; month: string; year: string; cvc: string; name: string };

/** Why a read failed, in plain words (never the value), and whether 1Password rate-limited it. */
export class CredError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

/** Where values come from: 1Password, or a test's fake vault. */
export interface Vault {
  resolve(reference: string): Promise<Credential>;
  /** A field of an Identity, Passport, Driver License or Social Security item, which has no website to check. */
  identity?(reference: string): Promise<Credential>;
  /** A Credit Card item's details, by its `op://vault/item` reference. */
  card?(reference: string): Promise<Card>;
  /** Lets go of what it holds (the helper process with the token). */
  close?(): void;
}

/** Makes a vault from the token; the node's makes the SDK helper's. */
export type VaultFor = (token: string) => Vault;

/** A card's expiry as 1Password keeps it (`MM/YYYY`, `MM/YY`, `YYYYMM`, `MMYYYY`), as a two-digit month and a
 * four-digit year. */
export function expiry(value: string): [month: string, year: string] | undefined {
  const digits = value.replace(/[^0-9]/g, "");
  let month: string;
  let year: string;
  if (value.includes("/")) {
    const at = value.indexOf("/");
    [month, year] = [value.slice(0, at).trim(), value.slice(at + 1).trim()];
  } else if (digits.length === 6 && digits.startsWith("20")) [month, year] = [digits.slice(4), digits.slice(0, 4)];
  else if (digits.length === 6 || digits.length === 4) [month, year] = [digits.slice(0, 2), digits.slice(2)];
  else return undefined;
  if (!/^\d+$/.test(month) || !/^\d+$/.test(year)) return undefined;
  const m = Number(month);
  if (m < 1 || m > 12) return undefined;
  if (year.length === 2) year = `20${year}`;
  else if (year.length !== 4) return undefined;
  return [String(m).padStart(2, "0"), year];
}

/** Whether a reference asks for a one-time code, which is never kept. */
export const isOtp = (reference: string) => reference.endsWith("?attribute=otp") || reference.endsWith("?attribute=totp");

const failed = (e: unknown) => (e instanceof CredError ? e : new CredError((e as Error).message, e instanceof OnePasswordError && e.rateLimited));

/** A session's resolved references, and until when it waits out a rate limit. */
export class Cache {
  private readonly kept = new Map<string, Credential>();
  private coolingUntil = 0;

  constructor(private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)) {}

  /** The reference's credential: kept, or resolved now (retrying after a rate limit). */
  async get(vault: Vault, reference: string, now: () => number = Date.now): Promise<Credential> {
    const kept = this.kept.get(reference);
    if (kept) return kept;
    if (this.coolingUntil > now()) {
      throw new CredError(
        `1Password rate-limited this machine's service account; this session asks again in ${Math.floor((this.coolingUntil - now()) / 1000) + 1} s`,
        true,
      );
    }
    let wait = RATE_LIMIT_WAIT_MS;
    let credential: Credential;
    for (let tries = 0; ; ) {
      try {
        credential = await vault.resolve(reference);
        break;
      } catch (e) {
        const error = failed(e);
        if (!error.rateLimited) throw error;
        if (tries + 1 < RATE_LIMIT_TRIES) {
          tries += 1;
          await this.sleep(wait);
          wait *= 2;
          continue;
        }
        this.coolingUntil = now() + RATE_LIMIT_COOLDOWN_MS;
        throw new CredError(`1Password is rate-limiting this machine's service account (${error.message}); try again in a few minutes`, true);
      }
    }
    // Not one-time codes, nor an item without a website, which a person may yet give one.
    if (!isOtp(reference) && credential.urls.length > 0) this.kept.set(reference, credential);
    return credential;
  }
}

/** The host of a URL, without a port: `https://shop.example.com:8443/x` → `shop.example.com`. */
export function hostOf(url: string): string | undefined {
  const scheme = url.indexOf("://");
  const rest = scheme >= 0 ? url.slice(scheme + 3) : url;
  const authority = rest.split(/[/?#]/)[0] ?? "";
  const at = authority.lastIndexOf("@");
  const host = at >= 0 ? authority.slice(at + 1) : authority;
  const plain = host.startsWith("[") ? host.slice(1).split("]")[0] : host.split(":")[0];
  return plain ? plain.toLowerCase() : undefined;
}

/** Whether the page at `page` is on one of the item's sites: the same host, or a subdomain of it. */
export function originAllowed(page: string, urls: string[]): boolean {
  const host = hostOf(page);
  if (!host) return false;
  return urls
    .map(hostOf)
    .some((site) => site !== undefined && (host === site || (host.endsWith(site) && host.slice(0, host.length - site.length).endsWith("."))));
}

/** The SDK helper as a session's vault. */
export class OnePasswordVault implements Vault {
  constructor(readonly helper: OnePassword) {}

  async resolve(reference: string): Promise<Credential> {
    try {
      return await this.helper.ask(reference);
    } catch (e) {
      throw failed(e);
    }
  }

  async identity(reference: string): Promise<Credential> {
    try {
      return await this.helper.identity(reference);
    } catch (e) {
      throw failed(e);
    }
  }

  async card(reference: string): Promise<Card> {
    let read: { number: string; expiry: string; cvc: string; name: string };
    try {
      read = await this.helper.card(reference);
    } catch (e) {
      throw failed(e);
    }
    const number = read.number.replace(/[^0-9]/g, "");
    if (number.length < 12) throw new CredError("the item has no card number");
    const expires = expiry(read.expiry);
    if (!expires) throw new CredError("the item has no expiry date fleetd can read");
    return { number, month: expires[0], year: expires[1], cvc: read.cvc, name: read.name };
  }

  close(): void {
    this.helper.close();
  }
}

/** The node's vaults: the SDK helper with the session's token. */
export const vaultFor =
  (home: string): VaultFor =>
  (token) =>
    new OnePasswordVault(new OnePassword(home, token));
