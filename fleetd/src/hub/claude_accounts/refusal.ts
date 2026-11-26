// What the workspace says of a Claude key Claude refused, at Save and at Test: pure, so fleetd cloud imports it
// (`fleetd/hub/claude_accounts/refusal`) and says the same without the hub's tools.

/** What the workspace says of a key Claude refused, at Save and at Test. */
export const KEY_REFUSED = "Claude refused this key: it isn't a valid API key.";
export const KEY_REFUSED_FIX = "Copy the key again from the Anthropic Console and paste it.";

/** Claude Code's own words for a refused key ("Invalid API key · Fix external API key") in plain words; any other
 * failure as it was said. */
export const plainRefusal = (said: string): string => (/invalid (x-)?api[ -]key|authentication_error|HTTP 401/iu.test(said) ? KEY_REFUSED : said);
