// The 1Password SDK helper with nothing of the machine's: its script (./onepassword_helper.mjs), run under Node.js with
// `@1password/sdk` at SDK_VERSION installed beside it, and its lines. The token is the first line on its stdin
// (`tokenLine`), then each question is one line and its answer one line back (`HelperAsks`, over an `exchange` that
// sends a request and reads the answer with `answerOf`). The node installs and runs it on its machine
// (./onepassword.ts); a service with no node runs the same one in the agent's box, with its own `exchange`.
import helperScript from "./onepassword_helper.mjs" with { type: "text" };
import type { OnePasswordCard } from "../../shared/contracts.ts";

/** The npm package the helper imports. */
export const SDK_PACKAGE = "@1password/sdk";
/** The SDK release the node installs. */
export const SDK_VERSION = "0.5.0";

/** The helper script the node runs under Node.js, with the SDK installed beside it. */
export const HELPER: string = helperScript;

/** One question to the helper. */
export type HelperRequest = { ref: string } | { identity: string } | { card: string } | { vaults: true } | { cards: true } | { search: string } | { read: string };
/** One answer from the helper, parsed: an error's was thrown by `answerOf`. */
export type HelperAnswer = Record<string, unknown>;

/** The helper's first line on stdin: the token, never in an environment or argument. */
export const tokenLine = (token: string): string => `${JSON.stringify({ token })}\n`;
/** One question as the line the helper reads. */
export const requestLine = (request: HelperRequest): string => `${JSON.stringify(request)}\n`;

/** What the helper answered as an error, in plain words (never a value), and whether 1Password rate-limited it. */
export class OnePasswordError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

/** One answer line, parsed; its error thrown as `1Password: …`. */
export function answerOf(line: string): HelperAnswer {
  let parsed: HelperAnswer;
  try {
    parsed = JSON.parse(line) as HelperAnswer;
  } catch {
    throw new Error("the 1Password helper said nothing readable");
  }
  if (typeof parsed.error === "string") throw new OnePasswordError(`1Password: ${parsed.error}`, parsed.rateLimited === true);
  return parsed;
}

/** The helper's questions, typed, over one line to it and its answer (`exchange`). */
export abstract class HelperAsks {
  /** One line to the helper and its answer, parsed (`answerOf`). */
  abstract exchange(request: HelperRequest): Promise<HelperAnswer>;

  /** A reference's value and its item's websites; an item without a website comes with no value (nothing fills it). */
  async ask(reference: string): Promise<{ value: string; urls: string[] }> {
    const parsed = await this.exchange({ ref: reference });
    const urls = (Array.isArray(parsed.urls) ? parsed.urls : []).filter((u): u is string => typeof u === "string");
    if (typeof parsed.value === "string") return { value: parsed.value, urls };
    if (parsed.value === undefined && urls.length === 0) return { value: "", urls };
    throw new OnePasswordError("1Password returned no value");
  }

  /** A field of an Identity, Passport, Driver License or Social Security item: for an approved secure input only. */
  async identity(reference: string): Promise<{ value: string; urls: string[] }> {
    const parsed = await this.exchange({ identity: reference });
    if (typeof parsed.value === "string" && parsed.value) return { value: parsed.value, urls: [] };
    throw new OnePasswordError("1Password returned no value");
  }

  /** A Credit Card item's details, as the helper reads them (browser/onepassword.ts shapes them). */
  async card(reference: string): Promise<{ number: string; expiry: string; cvc: string; name: string }> {
    const parsed = await this.exchange({ card: reference });
    const card = (parsed.card ?? {}) as Record<string, unknown>;
    const take = (key: string) => (typeof card[key] === "string" ? (card[key] as string) : "");
    return { number: take("number"), expiry: take("expiry"), cvc: take("cvc"), name: take("name") };
  }

  /** The names of the vaults the token reads: a token's Test. */
  async vaultNames(): Promise<string[]> {
    const parsed = await this.exchange({ vaults: true });
    return (Array.isArray(parsed.vaults) ? parsed.vaults : []).filter((v): v is string => typeof v === "string");
  }

  /** The Credit Card items the token reads: a project's card picker. */
  async cards(): Promise<OnePasswordCard[]> {
    const parsed = await this.exchange({ cards: true });
    return (Array.isArray(parsed.cards) ? parsed.cards : []).filter(
      (c): c is OnePasswordCard => !!c && typeof c.ref === "string" && typeof c.title === "string" && typeof c.vault === "string",
    );
  }

  /** The items a vault import may take whose title or website has `query` in it: overviews, never a value. */
  async search(query: string): Promise<Overview[]> {
    const parsed = await this.exchange({ search: query });
    return (Array.isArray(parsed.items) ? parsed.items : []).filter(
      (i): i is Overview => !!i && typeof i.ref === "string" && typeof i.title === "string" && typeof i.category === "string" && typeof i.vault === "string",
    );
  }

  /** One item's fields, for an import the person confirmed: sealed to the hub at once (vault_import_read). */
  async read(reference: string): Promise<ReadItem> {
    const parsed = await this.exchange({ read: reference });
    const item = (parsed.item ?? {}) as ReadItem;
    if (typeof item.title !== "string" || typeof item.category !== "string") throw new OnePasswordError("1Password returned no item");
    return { ...item, sites: Array.isArray(item.sites) ? item.sites.filter((u) => typeof u === "string") : [], fields: Array.isArray(item.fields) ? item.fields : [] };
  }
}

/** An item the helper's search found: its reference, title, category, vault and websites. */
export type Overview = { ref: string; title: string; category: string; vault: string; sites?: string[] };
/** An item the helper read for import: every field as 1Password keeps it. */
export type ReadItem = {
  title: string;
  category: string;
  sites: string[];
  notes?: string;
  fields: { id?: string; title?: string; type?: string; value?: string; details?: Record<string, unknown> }[];
};
