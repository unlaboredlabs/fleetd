// The hub's Claude endpoint as every setup screen takes it (`fleetd init`, the app's first run and Get started,
// Settings › Hub › Setup › Claude, the phone's Claude row): Anthropic's own prefilled, a custom one (a gateway, a proxy)
// typed over it. One on the team's tailnet (an address in 100.64.0.0/10 or fd7a:115c:a1e0::/48, a MagicDNS name under
// .ts.net) reaches hosted agents through the team's Tailscale gateway: while Tailscale isn't connected, the screen says
// so beside the field, with Connect. Pure, no Node: the CLI, the apps and the phone share it.

/** Anthropic's own API: what the endpoint field holds until someone types another. */
export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com";

/** The endpoint as typed, without trailing slashes. */
const tidy = (typed: string): string => typed.trim().replace(/\/+$/u, "");

/** What the hub keeps: nothing for Anthropic's own (empty, or the default as prefilled), else the endpoint as typed. */
export const endpointToSave = (typed: string): string | undefined => {
  const t = tidy(typed);
  return t === "" || t.toLowerCase() === ANTHROPIC_ENDPOINT ? undefined : t;
};

/** The field's value for a saved endpoint: Anthropic's own when there is none. */
export const endpointShown = (saved: string | undefined): string => saved ?? ANTHROPIC_ENDPOINT;

/** The host of `url` (http or https), lowercase, an IPv6 address without its brackets; undefined when it isn't a URL. */
export const hostOf = (url: string): string | undefined => {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/iu.exec(url.trim());
  const host = m?.[1]?.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  return host === undefined || host === "" ? undefined : host;
};

/** Whether `host` is a tailnet address or MagicDNS name: 100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net. */
export const tailnetHost = (host: string): boolean => {
  const h = host.toLowerCase();
  if (h === "ts.net" || h.endsWith(".ts.net")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    return a === 100 && b >= 64 && b < 128 && c <= 255 && d <= 255;
  }
  return h.includes(":") && /^fd7a:115c:a1e0:/u.test(h);
};

/** Whether the endpoint `url` is on a tailnet. */
export const onTailnet = (url: string): boolean => {
  const host = hostOf(url);
  return host !== undefined && tailnetHost(host);
};

/** The line beside an endpoint on the tailnet while Tailscale isn't connected; null when none is needed. */
export const tailnetLine = (url: string, connected: boolean): string | null =>
  !connected && onTailnet(url) ? "This endpoint is on your tailnet. Hosted agents reach it once Tailscale is connected." : null;
