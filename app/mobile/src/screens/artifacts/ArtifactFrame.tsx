// An HTML artifact in a WebView fenced as model.ts says: the page with the CSP ahead of it, its scripts on, and no
// bridge (no onMessage and nothing injected, so window.ReactNativeWebView never exists in it), no storage, cookies or
// files, and nothing loaded past the page itself. White behind it unless the page paints its own, as a browser would.
import { StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { artifactPage, FENCE, loadsOnly } from "./model";

export function ArtifactFrame({ html, title }: { html: string; title: string }) {
  return (
    <WebView
      {...FENCE}
      source={{ html: artifactPage(html), baseUrl: "about:blank" }}
      onShouldStartLoadWithRequest={(request) => loadsOnly(request.url)}
      accessibilityLabel={title}
      style={styles.page}
      containerStyle={styles.page}
    />
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#FFFFFF" },
});
