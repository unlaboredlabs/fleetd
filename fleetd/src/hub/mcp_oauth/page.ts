// The page a sign-in's browser tab ends on (callback.ts answers the redirect): a title and a line, escaped, with no
// scripts, frames or referrer.
export const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function page(status: number, rawTitle: string, rawText: string): Response {
  // Hosts and codes are marked as code for the app; the page shows them plain.
  const [title, text] = [escape(rawTitle), escape(rawText.replaceAll("`", ""))];
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" ` +
    `content="width=device-width,initial-scale=1"><title>${title} · fleetd</title><style>` +
    ":root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "font:15px/1.5 system-ui,-apple-system,sans-serif}main{max-width:28rem;padding:2rem}" +
    "h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>" +
    `<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-frame-options": "DENY",
    },
  });
}
