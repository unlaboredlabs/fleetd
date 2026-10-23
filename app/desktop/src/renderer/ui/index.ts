// The design system's public surface. Screens import from "../ui" (or "@/ui"), never from the files inside.
export { UiProvider } from "./UiProvider";
export { applyTheme, resolveTheme, isThemeMode, storedMode, useTheme, THEME_MODES, type ThemeMode, type ResolvedTheme } from "./theme";
export { cx } from "./lib/cx";
export { copyText } from "./lib/clipboard";

export { Text, textClass, type TextProps, type TextSize, type TextTone, type TextStyleProps } from "./text/Text";
export { Truncate, type TruncateProps } from "./text/Truncate";
export { IdChip, type IdChipProps } from "./text/IdChip";
export { humanizeKey } from "./text/humanize";

export { Button, Kbd, type ButtonProps, type ButtonVariant, type ButtonSize } from "./primitives/Button";
export {
  Field,
  Input,
  Textarea,
  Checkbox,
  Switch,
  RadioGroup,
  Radio,
  type InputProps,
  type TextareaProps,
  type CheckboxProps,
} from "./primitives/Field";
export { Select, type SelectProps, type SelectOption } from "./primitives/Select";
export { Menu, MenuTrigger, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "./primitives/Menu";
export { Dialog, Sheet, type DialogProps } from "./primitives/Dialog";
export { Tooltip, type TooltipProps } from "./primitives/Tooltip";
export { Popover, PopoverTrigger, PopoverContent } from "./primitives/Popover";
export { Tabs, TabList, Tab, TabPanel } from "./primitives/Tabs";
export { toast, type ToastInput, type ToastTone } from "./primitives/Toast";
export { Dot, StatusChip, RoleTag, roleTint, Separator, type StatusTone } from "./primitives/Chips";
export { ROLE_WORD, type AgentRole } from "./primitives/roles";

export { Code, InlineCode, renderTokens, type CodeProps } from "./markdown/Code";
export { resolveLang, langForPath, highlight, type CodeLang, type Tokens } from "./markdown/highlighter";
export { Markdown, type MarkdownProps } from "./markdown/Markdown";
export { VirtualList, type VirtualListProps } from "./list/VirtualList";
export {
  AppFrame,
  TopBar,
  FrameTitle,
  Breadcrumb,
  Sidebar,
  SidebarSection,
  SidebarItem,
  Panel,
  SectionHeader,
  Strip,
  StripItem,
  EmptyState,
  type Crumb,
  type SidebarItemProps,
} from "./layout/Layout";
export { GalleryScreen } from "./gallery";
