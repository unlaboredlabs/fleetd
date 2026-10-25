// Which links leave the app for the user's browser: http and https links of any host, nothing else. Opening an
// arbitrary URL from a page that renders hub content (agent messages, markdown) would let that content launch any
// handler the OS knows (file:, javascript:, custom app schemes), so every other scheme, links carrying credentials and
// over-long links are refused.

export const MAX_EXTERNAL_URL_LENGTH = 2048;

export type ExternalUrl = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string };

export const externalUrl = (input: string): ExternalUrl => {
  if (input.length > MAX_EXTERNAL_URL_LENGTH) return { ok: false, message: `The link is over ${MAX_EXTERNAL_URL_LENGTH} characters.` };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, message: "That isn't a link." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, message: "Only http and https links open in the browser." };
  if (url.username !== "" || url.password !== "") return { ok: false, message: "Links carrying a user name or password don't open." };
  return { ok: true, url: url.href };
};
