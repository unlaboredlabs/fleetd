// What a sign-in through the browser with a loopback redirect needs (githubConnect.ts, github.ts): a PKCE pair, and the
// page the browser lands on.
import { createHash, randomBytes } from "node:crypto";

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** A PKCE pair (RFC 7636, S256): a 43-character verifier and its challenge. */
export const pkce = (): { verifier: string; challenge: string } => {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
};

const escape = (text: string): string => text.replace(/[&<>"']/gu, (c) => `&#${String(c.charCodeAt(0))};`);

/** The page the browser lands on: plain, and pointing back to the app. */
export const landing = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>fleetd</title>` +
  `<body style="margin:0;height:90vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;color:#444;background:#fafafa">` +
  `<main style="max-width:28rem;padding:0 1.5rem"><p style="margin:0 0 .25rem;font-weight:600;color:#111">${escape(title)}</p>` +
  `<p style="margin:0">${escape(line)}</p></main></body>`;
