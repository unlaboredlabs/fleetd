// The chats list's bottom bar on iOS 26 (modules/toolbar): the filters button and its menu, iOS's own, beside the
// screen's search field in the navigation controller's toolbar. It draws nothing in the screen. A build without the
// module (one from before it, or before iOS 26, or Android) has `bottomBar` false: the list keeps search on top and
// its filters in the header.
import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import { Platform, StyleSheet, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";
import type { FilterChoice } from "../chatsBar";

interface NativeProps {
  readonly filters: ReadonlyArray<{ id: string; title: string; subtitle?: string | undefined; systemImage: string }>;
  readonly selected: string;
  readonly label: string;
  readonly filtered: boolean;
  readonly onSelect: (e: NativeSyntheticEvent<{ id: string }>) => void;
  readonly style: StyleProp<ViewStyle>;
}

const native = Platform.OS === "ios" ? requireOptionalNativeModule<{ supported?: boolean }>("FleetdToolbar") : null;

/** Whether this build and this iOS put the search field and the filters at the bottom. */
export const bottomBar = native?.supported === true;

const NativeToolbar: ComponentType<NativeProps> | null = bottomBar ? requireNativeView<NativeProps>("FleetdToolbar") : null;

export function Toolbar<F extends string>({ filters, selected, label, onSelect }: { filters: readonly (FilterChoice & { id: F })[]; selected: F; label: string; onSelect: (id: F) => void }) {
  if (NativeToolbar === null) return null;
  return (
    <NativeToolbar
      filters={filters.map((f) => ({ id: f.id, title: f.title, subtitle: f.subtitle, systemImage: f.symbol }))}
      selected={selected}
      label={label}
      filtered={selected !== filters[0]?.id}
      onSelect={(e) => onSelect(e.nativeEvent.id as F)}
      style={styles.none}
    />
  );
}

const styles = StyleSheet.create({
  none: { position: "absolute", width: 0, height: 0 },
});
