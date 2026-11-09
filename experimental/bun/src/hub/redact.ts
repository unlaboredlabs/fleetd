// Secrets out of text the app shows from places the hub doesn't control (crates/fleetd/src/hub/redact.rs): credentials
// caught by their shape, so a token an agent printed or a diff added is never shown.
export const SECRET = "[secret]";

/** Credentials recognised by their prefix or shape, replaced whole. */
const TOKENS = new RegExp(
  [
    String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$(?![\s\S]))`,
    String.raw`\bfld_[a-z2-7]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bsk-ant-[A-Za-z0-9_-]{16,}`,
    String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\bnpm_[A-Za-z0-9]{36}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  ].join("|"),
  "g",
);

/**
 * `Bearer <token>`, `https://user:pass@host` and `SOME_TOKEN=value`: the name stays, the value goes. A vault call's
 * `sealed` box and a `passphrase` count too (W549).
 */
const ASSIGNED = new RegExp(
  [
    String.raw`(?<pre>\bbearer\s+)(?<bearer>[A-Za-z0-9._~+/=-]{16,})`,
    String.raw`(?<scheme>\b[a-z][a-z0-9+.-]*:\/\/)(?<userinfo>[^\s/@:]+:[^\s/@]+)@`,
    String.raw`(?<name>\b[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passphrase|sealed|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?<value>[^\s"'\x60,;)}\]]{8,})`,
  ].join("|"),
  "gi",
);

/** `text` with every credential it recognises replaced by `[secret]`. */
export function redact(text: string): string {
  const tokens = text.replace(TOKENS, SECRET);
  return tokens.replace(ASSIGNED, (whole, ...args) => {
    const g = args.at(-1) as Record<string, string | undefined>;
    if (g.pre !== undefined) return `${g.pre}${SECRET}`;
    if (g.scheme !== undefined) return `${g.scheme}${SECRET}@`;
    const value = g.value ?? "";
    return /[0-9]/.test(value) && value !== SECRET ? `${g.name ?? ""}${SECRET}` : whole;
  });
}
