// iOS Settings' grouped inset lists: a section is a rounded group of rows with hairlines inset to the text, an
// uppercase header above and a footnote below. A row has an optional colored icon tile, a title, a value on the right
// and a chevron when it opens something.
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { shape, space, type, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

export function ListSection({ header, footer, children }: { header?: string; footer?: string; children: ReactNode }) {
  const t = useTheme();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.section}>
      {header === undefined ? null : (
        <Text style={[type.footnote, styles.header, { color: t.secondary }]} accessibilityRole="header">
          {header.toUpperCase()}
        </Text>
      )}
      <View style={[styles.group, { backgroundColor: t.cell }]}>
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {i === 0 ? null : <View style={[styles.separator, { backgroundColor: t.separator, marginLeft: (row.props as { icon?: unknown }).icon === undefined ? space.lg : 58 }]} />}
            {row}
          </Fragment>
        ))}
      </View>
      {footer === undefined ? null : <Text style={[type.footnote, styles.footer, { color: t.secondary }]}>{footer}</Text>}
    </View>
  );
}

export function ListRow({
  title,
  detail,
  value,
  valueColor,
  icon,
  tint,
  onPress,
  chevron = onPress !== undefined,
  destructive = false,
  selectable = false,
  accessory,
}: {
  title: string;
  /** A line under the title: why, where it failed. */
  detail?: string | undefined;
  value?: string | undefined;
  valueColor?: string | undefined;
  icon?: IconName;
  /** The icon tile's color; the accent when unset. */
  tint?: string | undefined;
  onPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  /** The value can be copied (an address, a version). */
  selectable?: boolean;
  accessory?: ReactNode;
}) {
  const t = useTheme();
  // At the accessibility text sizes the value goes under the title, as iOS Settings does, rather than be cut short.
  const stacked = useWindowDimensions().fontScale >= 1.35 && value !== undefined && detail === undefined;
  const body = (pressed: boolean) => (
    <View style={[styles.row, pressed && { backgroundColor: t.fillQuiet }]}>
      {icon === undefined ? null : (
        <View style={[styles.tile, { backgroundColor: tint ?? t.accentFill }]}>
          <Icon name={icon} size={17} color="#FFFFFF" weight="medium" />
        </View>
      )}
      {stacked ? (
        <View style={styles.grow}>
          <Text style={[type.body, { color: destructive ? t.danger : t.label }]}>{title}</Text>
          <Text style={[type.body, { color: valueColor ?? t.secondary }]} selectable={selectable}>
            {value}
          </Text>
        </View>
      ) : detail === undefined ? (
        <Text style={[type.body, value === undefined ? styles.grow : styles.title, { color: destructive ? t.danger : t.label }]} numberOfLines={1}>
          {title}
        </Text>
      ) : (
        <View style={styles.grow}>
          <Text style={[type.body, { color: destructive ? t.danger : t.label }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[type.footnote, { color: t.secondary }]}>{detail}</Text>
        </View>
      )}
      {value === undefined || stacked ? null : (
        <Text style={[type.body, detail === undefined ? styles.value : null, { color: valueColor ?? t.secondary }]} numberOfLines={1} selectable={selectable} ellipsizeMode="middle">
          {value}
        </Text>
      )}
      {accessory}
      {chevron ? <Icon name="chevron" size={14} color={t.tertiary} weight="semibold" /> : null}
    </View>
  );
  if (onPress === undefined) return body(false);
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: space.lg, marginTop: space.xl },
  header: { paddingHorizontal: space.lg, paddingBottom: 7 },
  footer: { paddingHorizontal: space.lg, paddingTop: 7 },
  group: { borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 11 },
  tile: { width: 29, height: 29, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  title: { flexShrink: 0, maxWidth: "60%" },
  grow: { flex: 1 },
  value: { flex: 1, textAlign: "right" },
});
