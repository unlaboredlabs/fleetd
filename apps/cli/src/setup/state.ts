import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MachineId } from "@fleetd/contracts";
import * as Schema from "effect/Schema";

export const GitIdentity = Schema.Struct({ name: Schema.String, email: Schema.String });
export type GitIdentity = typeof GitIdentity.Type;

/** What `fleetd machine add` set up on a machine, so `machine remove` can undo it with only the id. */
export const MachineRecord = Schema.Struct({
  sshHost: Schema.String,
  sshConfig: Schema.optionalKey(Schema.String),
  platform: Schema.Literals(["linux", "darwin"]),
  home: Schema.String,
  configHome: Schema.String,
  uid: Schema.Number,
  unitSuffix: Schema.String,
  t3Port: Schema.Number,
});
export type MachineRecord = typeof MachineRecord.Type;

/** `<hub home>/setup.json`: written by `fleetd init`, read by `machine add/remove` and `uninstall`. No secrets. */
export const SetupState = Schema.Struct({
  listen: Schema.String,
  /** Where devices and nodes reach the hub. */
  url: Schema.String,
  unitSuffix: Schema.String,
  /** Commit identity for every T3 and node fleetd sets up (public repos want the GitHub noreply address). */
  gitIdentity: Schema.optionalKey(GitIdentity),
  machines: Schema.Record(MachineId, MachineRecord),
});
export type SetupState = typeof SetupState.Type;

const codec = Schema.fromJsonString(SetupState);
export const setupFile = (home: string) => path.join(home, "setup.json");

export const readSetup = (home: string): SetupState | undefined => {
  const file = setupFile(home);
  return fs.existsSync(file) ? Schema.decodeUnknownSync(codec)(fs.readFileSync(file, "utf8")) : undefined;
};

export const writeSetup = (home: string, state: SetupState) => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(setupFile(home), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
};

/** `Name <email>`, as git prints an identity. */
export const parseGitIdentity = (value: string): GitIdentity | undefined => {
  const match = /^\s*([^<>]+?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/u.exec(value);
  return match === null ? undefined : { name: match[1]!, email: match[2]! };
};

export const isNoreply = (identity: GitIdentity) => identity.email.toLowerCase().endsWith("@users.noreply.github.com");

/** Commits made by agents and by the node carry this identity, without touching the machine's own git config. */
export const gitIdentityEnv = (identity: GitIdentity | undefined): Record<string, string> =>
  identity === undefined
    ? {}
    : {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      };

/**
 * `<hub home>/vapid.json` (0600) unless it exists: the P-256 pair the hub signs Web Push with, as
 * `{ publicKey, privateKey }` in base64url (65-byte uncompressed point, 32-byte scalar). True if it was created.
 */
export const ensureVapidKeys = (home: string): boolean => {
  const file = path.join(home, "vapid.json");
  if (fs.existsSync(file)) return false;
  // JWK coordinates are always full width, unlike ECDH.getPrivateKey(), which can drop a leading zero byte.
  const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")]);
  const keys = { publicKey: point.toString("base64url"), privateKey: jwk.d ?? "" };
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  return true;
};
