// An SF Symbol on iOS, and its Material Symbols match on Android and the web (expo-symbols draws both).
import { SymbolView, type AndroidSymbol, type SymbolViewProps } from "expo-symbols";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";

const SYMBOLS = {
  chats: ["bubble.left.and.bubble.right", "forum"],
  chatsOn: ["bubble.left.and.bubble.right.fill", "forum"],
  approvals: ["checkmark.shield", "verified_user"],
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
  hidden: ["eye.slash", "visibility_off"],
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
  scan: ["qrcode.viewfinder", "qr_code_scanner"],
  keyboard: ["keyboard", "keyboard"],
  close: ["xmark", "close"],
  camera: ["camera.fill", "photo_camera"],
  status: ["antenna.radiowaves.left.and.right", "sensors"],
  info: ["info", "info"],
  reply: ["arrowshape.turn.up.left", "reply"],
  copy: ["doc.on.doc", "content_copy"],
  select: ["selection.pin.in.out", "select_all"],
  pin: ["pin", "push_pin"],
  pinned: ["pin.fill", "push_pin"],
  unpin: ["pin.slash", "keep_off"],
  mute: ["bell.slash", "notifications_off"],
  unmute: ["bell", "notifications"],
  read: ["checkmark.message", "mark_chat_read"],
  unread: ["message.badge", "mark_chat_unread"],
  plus: ["plus", "add"],
  photos: ["photo.on.rectangle", "photo_library"],
  takePhoto: ["camera", "photo_camera"],
  file: ["doc", "description"],
  share: ["square.and.arrow.up", "ios_share"],
  down: ["chevron.down", "keyboard_arrow_down"],
  search: ["magnifyingglass", "search"],
  done: ["checkmark", "check"],
  sealed: ["checkmark.seal.fill", "verified"],
  bubble: ["bubble.left.fill", "chat_bubble"],
  pdf: ["doc.richtext", "picture_as_pdf"],
} as const satisfies Record<string, readonly [Extract<SymbolViewProps["name"], string>, AndroidSymbol]>;

export type IconName = keyof typeof SYMBOLS;

/** The SF Symbol's name, for what iOS draws itself (the tab bar). */
export const sfSymbol = (name: IconName): (typeof SYMBOLS)[IconName][0] => SYMBOLS[name][0];

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
