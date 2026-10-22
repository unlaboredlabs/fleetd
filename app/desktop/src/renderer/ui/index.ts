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
export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuLabel,
  MenuGroup,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubContent,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./primitives/Menu";
export { Dialog, Sheet, DialogClose, type DialogProps } from "./primitives/Dialog";
export { Tooltip, type TooltipProps } from "./primitives/Tooltip";
export { Popover, PopoverTrigger, PopoverContent, PopoverClose, PopoverAnchor } from "./primitives/Popover";
export { Tabs, TabList, Tab, TabPanel } from "./primitives/Tabs";
export { toast, type ToastInput, type ToastTone } from "./primitives/Toast";
export { ScrollArea, type ScrollAreaProps } from "./primitives/ScrollArea";
export { Dot, StatusChip, RoleTag, roleTint, Separator, type StatusTone, type AgentRole } from "./primitives/Chips";

export { Code, InlineCode, type CodeProps } from "./markdown/Code";
export { resolveLang, langForPath, type CodeLang } from "./markdown/highlighter";
export { Markdown, type MarkdownProps } from "./markdown/Markdown";
export { VirtualList, type VirtualListProps } from "./list/VirtualList";
export { DataTable, type DataTableProps, type Column } from "./list/DataTable";
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
export { DiffView, type DiffViewProps, type DiffMode } from "./diff/DiffView";
export { parsePatch, toSplitRows, type ParsedPatch, type DiffFile, type DiffHunk, type DiffLine } from "./diff/parsePatch";
export { GalleryScreen } from "./gallery";
