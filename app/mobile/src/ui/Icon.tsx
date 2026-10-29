// An SF Symbol on iOS, and its Material Symbols match on Android and the web (expo-symbols draws both).
import { SymbolView, type AndroidSymbol, type SymbolViewProps } from "expo-symbols";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";

const SYMBOLS = {
  chats: ["bubble.left.and.bubble.right", "forum"],
  chatsOn: ["bubble.left.and.bubble.right.fill", "forum"],
  approvals: ["checkmark.shield", "verified_user"],
  approvalsOn: ["checkmark.shield.fill", "verified_user"],
  settings: ["gearshape", "settings"],
  settingsOn: ["gearshape.fill", "settings"],
  send: ["arrow.up", "arrow_upward"],
  chevron: ["chevron.right", "chevron_right"],
  chevronDown: ["chevron.down", "expand_more"],
  check: ["checkmark.circle.fill", "check_circle"],
  unchecked: ["circle", "radio_button_unchecked"],
  pr: ["arrow.triangle.pull", "merge"],
  external: ["arrow.up.right", "open_in_new"],
  money: ["creditcard", "payments"],
  irreversible: ["exclamationmark.triangle", "warning"],
  credential: ["key", "key"],
  error: ["exclamationmark.circle.fill", "error"],
  offline: ["wifi.slash", "cloud_off"],
  sparkles: ["sparkles", "auto_awesome"],
  folder: ["folder", "folder"],
  table: ["tablecells", "table_chart"],
  block: ["rectangle.on.rectangle", "desktop_windows"],
  lock: ["lock.fill", "lock"],
  bell: ["bell.badge.fill", "notifications"],
  phone: ["iphone", "smartphone"],
  server: ["server.rack", "dns"],
  update: ["arrow.triangle.2.circlepath", "sync"],
  doneAll: ["checkmark.circle", "task_alt"],
  qr: ["qrcode", "qr_code"],
  link: ["link", "link"],
  paste: ["doc.on.clipboard", "content_paste"],
} as const satisfies Record<string, readonly [Extract<SymbolViewProps["name"], string>, AndroidSymbol]>;

export type IconName = keyof typeof SYMBOLS;

export function Icon({
  name,
  size = 22,
  color,
  weight = "regular",
  style,
}: {
  name: IconName;
  size?: number;
  color: ColorValue;
  weight?: "regular" | "medium" | "semibold" | "bold";
  style?: StyleProp<ViewStyle>;
}) {
  const [ios, material] = SYMBOLS[name];
  return <SymbolView name={{ ios, android: material, web: material }} size={size} tintColor={color} weight={weight} style={style} />;
}
