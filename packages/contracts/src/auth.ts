import { Schema } from "effect";
import { MachineId, Timestamp } from "./ids.ts";

export const Role = Schema.Literals(["read", "operate", "admin"]);
export type Role = typeof Role.Type;

export const Grant = Schema.Struct({
  role: Role,
  machines: Schema.Union([Schema.Literal("*"), Schema.Array(MachineId)]),
});
export type Grant = typeof Grant.Type;

/** "fld_" plus the first 6 characters of the key's lowercase base32 body. */
export const AgentKeyPrefix = Schema.String.check(Schema.isPattern(/^fld_[a-z2-7]{6}$/u));

export const AgentKeyInfo = Schema.Struct({
  keyId: Schema.NonEmptyString,
  name: Schema.String,
  prefix: AgentKeyPrefix,
  grants: Schema.Array(Grant),
  createdAt: Timestamp,
  lastUsedAt: Schema.optionalKey(Timestamp),
  revokedAt: Schema.optionalKey(Timestamp),
});
export type AgentKeyInfo = typeof AgentKeyInfo.Type;
