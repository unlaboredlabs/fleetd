import { Schema } from "effect";
import { MachineId } from "./ids.ts";

// M8 secrets: the desktop app seals a value to the target node's X25519 key (libsodium `crypto_box_seal`); the hub only
// relays the ciphertext and keeps the fingerprint the node reports back.

const ALPHABETS = {
  base64: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
};
const BODY = { base64: /^[A-Za-z0-9+/]*$/u, base64url: /^[A-Za-z0-9_-]*$/u };

/**
 * Decoded byte length of canonical base64, or undefined for anything else: wrong alphabet, impossible length, or
 * nonzero unused bits in the last character (so each byte string has exactly one encoding). Standard base64 must be
 * padded; base64url, as browsers export push keys, may be unpadded.
 */
export const base64Bytes = (text: string, alphabet: keyof typeof ALPHABETS): number | undefined => {
  const body = text.replace(/={1,2}$/u, "");
  const padded = body.length !== text.length;
  if (!BODY[alphabet].test(body) || body.length % 4 === 1) return undefined;
  if ((alphabet === "base64" || padded) && text.length % 4 !== 0) return undefined;
  const last = body.at(-1);
  if (last !== undefined && ALPHABETS[alphabet].indexOf(last) % (1 << ((body.length * 6) % 8)) !== 0) return undefined;
  return Math.floor((body.length * 6) / 8);
};

const base64Of = (alphabet: keyof typeof ALPHABETS, min: number, max: number, expected: string) =>
  Schema.String.check(
    Schema.makeFilter(
      (text: string) => {
        const bytes = base64Bytes(text, alphabet);
        return bytes !== undefined && bytes >= min && bytes <= max;
      },
      { expected },
    ),
  );

/** The node's X25519 public key for sealed boxes: standard base64 of 32 bytes. */
export const BoxPublicKey = base64Of("base64", 32, 32, "standard base64 of a 32-byte X25519 public key").annotate({
  identifier: "BoxPublicKey",
});

/** Plaintext limit for one secret. */
export const SECRET_MAX_BYTES = 8192;
/** `crypto_box_seal` adds an ephemeral public key (32) and a MAC (16). */
const SEAL_OVERHEAD = 48;

/** A `crypto_box_seal` ciphertext, standard base64; at least one plaintext byte, at most SECRET_MAX_BYTES. */
export const SealedSecret = base64Of(
  "base64",
  SEAL_OVERHEAD + 1,
  SEAL_OVERHEAD + SECRET_MAX_BYTES,
  `standard base64 of a sealed box holding 1 to ${SECRET_MAX_BYTES} bytes`,
).annotate({ identifier: "SealedSecret" });

/** The first 8 hex characters of sha256 over the plaintext, computed by the node. */
export const SecretFingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}$/u)).annotate({
  identifier: "SecretFingerprint",
  description: "8 lowercase hex characters: the sha256 prefix of the plaintext",
});

export const SecretSinkKind = Schema.Literals(["env", "file"]);
export type SecretSinkKind = typeof SecretSinkKind.Type;

export type ParsedSecretSink = { readonly kind: SecretSinkKind; readonly machineId: MachineId; readonly path: string };

const SINK = /^(env|file):([a-z0-9-]{1,32}):(\/.*)$/u;

/**
 * Splits a valid sink; undefined for anything else. The path must be absolute with no empty, "." or ".." segment and
 * no control characters, so the node can check it against its command roots by prefix.
 */
export const parseSecretSink = (sink: string): ParsedSecretSink | undefined => {
  const match = SINK.exec(sink);
  if (match === null || sink.length > 1000) return undefined;
  const [, kind, machineId, path] = match as unknown as [string, SecretSinkKind, string, string];
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(path)) return undefined;
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return { kind, machineId: MachineId.make(machineId), path };
};

/**
 * Where the node writes a secret, mode 0600, under its command roots. `env:<machine>:<path>` adds or replaces one
 * KEY=VALUE line in an env file; `file:<machine>:<path>` writes the raw value.
 */
export const SecretSink = Schema.String.check(
  Schema.makeFilter((sink: string) => parseSecretSink(sink) !== undefined, {
    expected: "env:<machine>:<absolute path> or file:<machine>:<absolute path>, with no empty, . or .. path segment",
  }),
).annotate({ identifier: "SecretSink" });
export type SecretSink = typeof SecretSink.Type;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/**
 * The variable an `env:` sink writes for a secret ask without `--env-name`: its key uppercased, with `.` and `-` as
 * `_` (`stripe.test_key` is `STRIPE_TEST_KEY`). Undefined when that is no valid name (a key starting with a digit).
 */
export const secretEnvName = (secretKey: string): string | undefined => {
  const name = secretKey.toUpperCase().replace(/[.-]/gu, "_");
  return ENV_NAME.test(name) ? name : undefined;
};
