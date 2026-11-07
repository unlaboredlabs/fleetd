// The fence against react-native-webview's own navigation handling, as ArtifactFrame wires it: a URL outside the
// library's originWhitelist is opened in the browser before onShouldStartLoadWithRequest is asked, so the fence's
// list lets every address through to loadsOnly, which refuses them. And what no CSP covers (a preconnect) goes through
// the proxy to nowhere that patches/ gives an incognito WebView's own data store on iOS.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openURL = vi.fn(async () => true);
vi.mock("react-native", () => ({
  Linking: { canOpenURL: async () => true, openURL },
  StyleSheet: { create: <T>(s: T) => s },
  View: () => null,
  Text: () => null,
  ActivityIndicator: () => null,
}));
// The library's own source, which vitest compiles with the mock above; named by a variable so tsc leaves it unchecked.
const SHARED = "react-native-webview/src/WebViewShared";
type Request = { url: string };
const { createOnShouldStartLoadWithRequest } = (await import(/* @vite-ignore */ SHARED)) as {
  createOnShouldStartLoadWithRequest: (
    load: (shouldStart: boolean) => void,
    originWhitelist: readonly string[],
    onShouldStart: (request: Request) => boolean,
  ) => (event: { nativeEvent: Request & { lockIdentifier: number } }) => void;
};
const { FENCE, loadsOnly } = await import("./model");

/** What the WebView does with a navigation to `url`: whether it loads, after the browser had its chance. */
const navigate = async (url: string, originWhitelist: readonly string[]): Promise<boolean> => {
  let started: boolean | undefined;
  const handle = createOnShouldStartLoadWithRequest(
    (shouldStart) => {
      started = shouldStart;
    },
    originWhitelist,
    (request) => loadsOnly(request.url),
  );
  handle({ nativeEvent: { url, lockIdentifier: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return started ?? true;
};

describe("an HTML artifact's navigations", () => {
  beforeEach(() => openURL.mockClear());

  it("never reach the browser: a script's location change, form or redirect is refused, nothing opened", async () => {
    for (const url of ["https://example.com/?leak=1", "http://100.64.0.1:4798/navigate", "mailto:a@b.dev", "tel:123", "fleetd://pair?x"]) {
      expect(await navigate(url, FENCE.originWhitelist), url).toBe(false);
    }
    expect(openURL).not.toHaveBeenCalled();
  });

  it("stay on the page itself", async () => {
    expect(await navigate("about:blank", FENCE.originWhitelist)).toBe(true);
    expect(await navigate("about:blank#totals", FENCE.originWhitelist)).toBe(true);
  });

  it("would open in the browser with the library's narrower list, which is why the fence lets all through", async () => {
    expect(await navigate("https://example.com/?leak=1", ["about:blank"])).toBe(false);
    expect(openURL).toHaveBeenCalledWith("https://example.com/?leak=1");
  });
});

describe("an HTML artifact's connections", () => {
  it("go through a proxy to nowhere: the fence is incognito, and the patch gives that store the proxy", () => {
    expect(FENCE.incognito).toBe(true);
    const patch = readFileSync(new URL("../../../patches/react-native-webview+14.0.1.patch", import.meta.url), "utf8");
    expect(patch).toContain('nw_endpoint_create_host("0.0.0.0", "9")');
    expect(patch).toContain("nw_proxy_config_set_failover_allowed(proxy, false)");
    expect(patch).toContain("websiteDataStore.proxyConfigurations = @[proxy]");
  });
});
