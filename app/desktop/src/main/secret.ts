// Secret requests: the value is sealed here, in main, to the sink machine's X25519 box key with libsodium's
// crypto_box_seal (the same construction as the node's crypto_box_seal_open and the old app's seal.rs), so the hub
// only relays ciphertext and the renderer never gets the plaintext back. It is never logged.
import type { ToolInput } from "../shared/contracts";
import type { CallOutcome, HubError, SecretOutcome } from "../shared/hub";
import type { SecretRequest } from "../shared/ipc";

/** fleetd_contracts::secrets::SECRET_MAX_BYTES. */
export const SECRET_MAX_BYTES = 8192;

const refused = (message: string, fix?: string): { ok: false; error: HubError } => ({
  ok: false,
  error: { code: "invalid", message, ...(fix === undefined ? {} : { fix }) },
});

/** Standard base64 of `crypto_box_seal(value)` for `boxPubKey` (standard base64 of 32 bytes), or why not. */
export const seal = async (boxPubKey: string, value: string): Promise<{ ok: true; sealed: string } | { ok: false; error: HubError }> => {
  const plain = new TextEncoder().encode(value);
  try {
    if (plain.length === 0) return refused("The secret is empty.", "Type or paste the value, then send it.");
    if (plain.length > SECRET_MAX_BYTES) {
      return refused(`The secret is over ${SECRET_MAX_BYTES} bytes.`, "Send a shorter value, or put a file on the machine and send its path.");
    }
    const key = Buffer.from(boxPubKey.trim(), "base64");
    if (key.length !== 32 || key.toString("base64") !== boxPubKey.trim()) {
      return refused("The machine's box key is not a 32-byte key.", "Restart the node on that machine so it reports its key again.");
    }
    // Loaded on the first secret, not at startup: libsodium instantiates its WebAssembly on import.
    const { default: sodium } = await import("libsodium-wrappers");
    await sodium.ready;
    return { ok: true, sealed: Buffer.from(sodium.crypto_box_seal(plain, key)).toString("base64") };
  } finally {
    plain.fill(0);
  }
};

/** Seals, then hands the box to secret_submit. Only the node's fingerprint of the value comes back. */
export const submitSecret = async (
  request: SecretRequest,
  // Typed against the generated contracts, so a renamed tool or field fails typecheck instead of the hub call.
  call: (tool: "secret_submit", input: ToolInput<"secret_submit">) => Promise<CallOutcome>,
): Promise<SecretOutcome> => {
  const sealed = await seal(request.boxPubKey, request.value);
  if (!sealed.ok) return sealed;
  const out = await call("secret_submit", { requestId: request.requestId, sealed: sealed.sealed });
  if (!out.ok) return out;
  const fingerprint = (out.output as { fingerprint?: unknown } | null)?.fingerprint;
  return { ok: true, fingerprint: typeof fingerprint === "string" ? fingerprint : "" };
};
