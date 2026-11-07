// An HTML artifact in a WebView fenced as model.ts says: the page with the CSP and its first script ahead of it, its
// scripts on, no storage, cookies or files, nothing loaded past the page itself, and on iOS every connection sent to a
// proxy that goes nowhere (incognito's data store, patches/). Nothing is injected; the one message taken from it is a
// person's tap on a link, carrying the key only the first script holds, which opens in the browser as a Markdown link
// does. White behind it unless the page paints its own, as a browser would.
import { getRandomBytes } from "expo-crypto";
import { useMemo } from "react";
import { Linking, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { artifactPage, FENCE, linkOf, loadsOnly } from "./model";

export function ArtifactFrame({ html, title }: { html: string; title: string }) {
  const key = useMemo(() => Array.from(getRandomBytes(16), (b) => b.toString(16).padStart(2, "0")).join(""), []);
  const page = useMemo(() => artifactPage(html, key), [html, key]);
  return (
    <WebView
      {...FENCE}
      source={{ html: page, baseUrl: "about:blank" }}
      onShouldStartLoadWithRequest={(request) => loadsOnly(request.url)}
      onMessage={(e) => {
        const href = linkOf(e.nativeEvent.data, key);
        if (href !== undefined) void Linking.openURL(href);
      }}
      accessibilityLabel={title}
      style={styles.page}
      containerStyle={styles.page}
    />
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#FFFFFF" },
});
