// A screen whose drawing throws shows "Something went wrong" with Reload, and the rest of the app goes on: without it,
// one bad value in one row (a release build has no red screen) ended the whole app. Each navigator's screens are laid
// out in one (StripRoom.tsx, Covered.tsx), and the app as a whole in another, for what fails outside a screen. What
// failed goes to the person's workspace (appErrors.ts) with the screen's name; Reload draws the screen afresh, and Back
// leaves it where there is a screen to go back to (the chat draws its own Back, which went with it).
import { Component, Fragment, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { appErrors } from "../appErrorsDevice";
import { space, type, useTheme } from "../theme";
import { Button } from "./Button";
import { Icon } from "./Icon";

export const FAILED_TITLE = "Something went wrong";
export const FAILED_BODY = "This screen stopped. Details went to your workspace.";

/** How a screen in a navigator goes back: undefined where there is nothing to go back to. */
export interface Leave {
  readonly canGoBack: () => boolean;
  readonly goBack: () => void;
}

export class Caught extends Component<{ screen: string; leave?: Leave | undefined; children: ReactNode }, { failed: boolean; drawn: number }> {
  override state = { failed: false, drawn: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    appErrors.note(error, { fatal: false, screen: this.props.screen, componentStack: info.componentStack });
  }

  override render(): ReactNode {
    if (this.state.failed) {
      const { leave } = this.props;
      return <Failed onReload={() => this.setState((s) => ({ failed: false, drawn: s.drawn + 1 }))} onBack={leave?.canGoBack() === true ? () => leave.goBack() : undefined} />;
    }
    // A new key on Reload: the screen's own state starts over, rather than drawing what threw again. No view of its
    // own, so a screen (a sheet sized to its content) lays out as without it.
    return <Fragment key={this.state.drawn}>{this.props.children}</Fragment>;
  }
}

/** As an empty state (States.tsx) says it, a little way down the screen, with Back beside Reload where it can go back. */
function Failed({ onReload, onBack }: { onReload: () => void; onBack: (() => void) | undefined }) {
  const t = useTheme();
  const { height } = useWindowDimensions();
  return (
    <View style={[styles.fill, { backgroundColor: t.bg }]}>
      <View style={[styles.failed, { paddingTop: Math.round(height * 0.14) }]}>
        <View style={[styles.disc, { backgroundColor: t.accentSoft }]}>
          <Icon name="error" size={34} color={t.accent} />
        </View>
        <Text style={[type.title3, { color: t.label }, styles.center]}>{FAILED_TITLE}</Text>
        <Text style={[type.subhead, { color: t.secondary }, styles.center]}>{FAILED_BODY}</Text>
        <View style={styles.actions}>
          {onBack === undefined ? null : <Button label="Back" kind="plain" size="small" onPress={onBack} />}
          <Button label="Reload" kind="tinted" size="small" onPress={onReload} />
        </View>
      </View>
    </View>
  );
}

/** `children` (a screen) in a Caught named after `screen`, which leaves by `leave` (its navigator's). */
export const caught = (screen: string, children: ReactElement, leave?: Leave): ReactElement => (
  <Caught screen={screen} leave={leave}>
    {children}
  </Caught>
);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  failed: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xxl, paddingBottom: space.xl },
  disc: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  center: { textAlign: "center" },
  actions: { flexDirection: "row", gap: space.md, marginTop: space.xs },
});
