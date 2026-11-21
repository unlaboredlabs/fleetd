// Logins from 1Password, filled without the agent seeing them. The node
// resolves an `op://` reference with the SDK helper (../actions/onepassword.ts, the Rust node's own script) and a
// service account token: the project's or order's secret variable OP_SERVICE_ACCOUNT_TOKEN, else the token the person
// whose work it is saved. The token never reaches an agent's environment. Each session keeps what it resolved (not
// one-time codes, which change every 30 s) and backs off when 1Password rate-limits the token. The same helper reads a
// Credit Card item's details for an approved purchase only (cards.ts), and an identity field for an approved secure
// input (secure_input.ts).
import { OnePassword } from "../actions/onepassword.ts";
import { type Card, type Credential, CredError, expiry, failed, type Vault, type VaultFor } from "./logins.ts";

export * from "./logins.ts";

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
