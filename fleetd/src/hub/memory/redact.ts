// Secrets out of text the hub shows or keeps from places it doesn't control:
// credentials recognised by their shape, replaced by `[secret]`.
export const SECRET = "[secret]";

/** Credentials recognised by their prefix or shape, replaced whole. */
const TOKENS = new RegExp(
  [
    String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)`,
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

/** `Bearer <token>`, `https://user:pass@host` and `SOME_TOKEN=value`: the name stays, the value goes. */
const ASSIGNED = new RegExp(
  [
    String.raw`(?<pre>\bbearer\s+)(?<bearer>[A-Za-z0-9._~+/=-]{16,})`,
    String.raw`(?<scheme>\b[a-z][a-z0-9+.-]*://)(?<userinfo>[^\s/@:]+:[^\s/@]+)@`,
    String.raw`(?<name>\b[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?<value>[^\s"'\x60,;)}\]]{8,})`,
  ].join("|"),
  "gi",
);

/** `text` with every credential it recognises replaced by `[secret]`. */
export function redact(text: string): string {
  const tokens = text.replace(TOKENS, SECRET);
  return tokens.replace(ASSIGNED, (whole, ...args) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    if (groups.pre !== undefined) return `${groups.pre}${SECRET}`;
    if (groups.scheme !== undefined) return `${groups.scheme}${SECRET}@`;
    const value = groups.value ?? "";
    return /[0-9]/.test(value) && value !== SECRET ? `${groups.name ?? ""}${SECRET}` : whole;
  });
}
