// How the node's call handlers in this directory refuse a `session_call`: the session service turns one into the
// reply's SessionError (sessions/index.ts), with its code, its plain words and a fix when there is one.
import type { SessionErrorCode } from "../../shared/sessions.ts";

export class CallRefusal extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}

export const invalid = (message: string) => new CallRefusal("invalid", message);
export const notFound = (message: string) => new CallRefusal("not_found", message);

/** The errno's name (ENOENT, EACCES) of an fs failure, else its message, as the Rust node's `io_why`. */
export const ioWhy = (error: unknown) => (error as { code?: string }).code ?? (error as Error).message ?? String(error);

/** A file's bytes, or undefined when it doesn't exist; other failures throw. */
export function readIfThere(read: () => Buffer): Buffer | undefined {
  try {
    return read();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Removes a file; one that isn't there is fine. */
export function removeIfThere(remove: () => void): void {
  try {
    remove();
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

/** A sealed box's plaintext opened with the node's box key from standard base64, or null. */
export function openB64(boxKey: { open(sealed: Uint8Array): Uint8Array | null }, sealedB64: string): Uint8Array | null {
  const boxed = Buffer.from(sealedB64, "base64");
  try {
    return boxKey.open(boxed);
  } finally {
    boxed.fill(0);
  }
}

/** Whether `text` holds a control character, as Rust's `char::is_control` (Unicode Cc). */
export const hasControl = (text: string) => /\p{Cc}/u.test(text);

/** `text` as UTF-8, or undefined when its bytes aren't valid UTF-8. */
export function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
