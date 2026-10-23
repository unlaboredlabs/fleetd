import { ChevronRight } from "lucide-react";
import { createContext, Fragment, useContext, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { Text } from "../text/Text";
import { Truncate } from "../text/Truncate";
import s from "./layout.module.css";

// The top row's middle, where the screen on show puts its title (FrameTitle): one header row, not two.
const TitleSlot = createContext<HTMLElement | null>(null);
const SetTitleSlot = createContext<(el: HTMLElement | null) => void>(() => undefined);

/**
 * The window: a sidebar down the left, from the very top (the macOS traffic lights sit in it), and beside it the
 * top row over the main area (which owns its own scrolling). `sidebarTop` is the sidebar's first row, beside the
 * traffic lights; without a sidebar the top row runs the full width and starts after them.
 */
export function AppFrame(props: {
  topBar: ReactNode;
  sidebar?: ReactNode;
  sidebarTop?: ReactNode;
  /** The window's own frame: its sidebar shows the window's translucent material where there is one (macOS). */
  translucent?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SetTitleSlot.Provider value={setSlot}>
      <TitleSlot.Provider value={slot}>
        <div className={cx(s.frame, !props.sidebar && s.noSidebar, props.translucent && s.translucent, props.className)}>
          {props.sidebar ? (
            <div className={s.side}>
              <div className={s.sideTop}>{props.sidebarTop}</div>
              {props.sidebar}
            </div>
          ) : null}
          {props.topBar}
          <main className={s.main}>{props.children}</main>
        </div>
      </TitleSlot.Provider>
    </SetTitleSlot.Provider>
  );
}

/**
 * The top row over the main area, and the window's drag region. Its middle holds the current screen's FrameTitle;
 * buttons and fields inside stay clickable.
 */
export function TopBar(props: { leading?: ReactNode; trailing?: ReactNode; className?: string }) {
  const setSlot = useContext(SetTitleSlot);
  return (
    <header className={cx(s.topBar, props.className)}>
      {props.leading ? <div className={s.topLeading}>{props.leading}</div> : null}
      <div ref={setSlot} className={s.topCenter} />
      {props.trailing ? <div className={s.topTrailing}>{props.trailing}</div> : null}
    </header>
  );
}

/**
 * A screen's header, in the frame's top row rather than a header bar of the screen's own: every page's one header
 * style. `title` is the page's name (its heading), `detail` a quiet line beside it, `lead` what comes before it (a
 * way back), and `children` the page's controls and state, at the end.
 */
export function FrameTitle(props: { title?: string | undefined; detail?: string | undefined; lead?: ReactNode; children?: ReactNode }) {
  const slot = useContext(TitleSlot);
  if (slot === null) return null;
  return createPortal(
    <>
      <span className={s.frameTitle}>
        {props.lead}
        {props.title === undefined ? null : (
          <Truncate as="h1" strong className={s.frameHeading}>
            {props.title}
          </Truncate>
        )}
        {props.detail === undefined ? null : (
          <Truncate size="xs" tone="quiet" className={s.frameDetail}>
            {props.detail}
          </Truncate>
        )}
      </span>
      {props.children}
    </>,
    slot,
  );
}

export interface Crumb {
  label: string;
  onClick?: () => void;
}

/** Where you are: each crumb truncates (tooltip has the full name), earlier crumbs give way first. */
export function Breadcrumb({ items, className }: { items: ReadonlyArray<Crumb>; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cx(s.crumbs, className)}>
      {items.map((c, i) => (
        <Fragment key={`${String(i)}:${c.label}`}>
          {i > 0 ? <ChevronRight size={12} className={s.crumbSep} aria-hidden /> : null}
          <span className={s.crumb} {...(i === items.length - 1 ? { "aria-current": "page" as const } : {})}>
            {c.onClick ? (
              <button type="button" className={s.crumbLink} onClick={c.onClick}>
                <Truncate expand="none" tone="inherit" strong={i === items.length - 1}>
                  {c.label}
                </Truncate>
              </button>
            ) : (
              <Truncate tone="inherit" strong={i === items.length - 1}>
                {c.label}
              </Truncate>
            )}
          </span>
        </Fragment>
      ))}
    </nav>
  );
}

/** The sidebar's rows, which scroll; `footer` stays at the bottom, outside the scroll. */
export function Sidebar({
  children,
  footer,
  className,
  "aria-label": label,
}: {
  children: ReactNode;
  footer?: ReactNode;
  className?: string | undefined;
  "aria-label"?: string;
}) {
  return (
    <nav className={cx(s.sidebar, className)} aria-label={label ?? "Sidebar"}>
      <div className={s.sidebarBody}>{children}</div>
      {footer}
    </nav>
  );
}

/** A titled group of sidebar rows, with an optional action (a + button) on the title line. */
export function SidebarSection(props: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.sidebarSection}>
      {props.title || props.action ? (
        <div className={s.sidebarSectionHead}>
          <span className={s.sidebarSectionTitle}>{props.title ? <Truncate size="xs" tone="quiet">{props.title}</Truncate> : null}</span>
          {props.action}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

export interface SidebarItemProps extends Omit<ComponentProps<"button">, "children"> {
  label: string;
  icon?: ReactNode;
  /** A count, a dot, a shortcut: right-aligned, quiet. */
  trailing?: ReactNode;
  /** The current page. */
  current?: boolean;
  /** Nested under the row above (a project's orders). */
  indent?: boolean;
  /** Something new since you last looked: the label in full weight. */
  emphasis?: boolean;
}

/** One sidebar row, 28 px tall: icon, a label that truncates with a tooltip, and trailing detail. */
export function SidebarItem({ label, icon, trailing, current, indent, emphasis, className, ...rest }: SidebarItemProps) {
  return (
    <button
      type="button"
      className={cx(s.sidebarItem, indent && s.indent, className)}
      {...(current ? { "aria-current": "page" as const } : {})}
      {...rest}
    >
      {icon}
      <span className={s.sidebarLabel}>
        <Truncate expand="none" tone="inherit" strong={emphasis === true}>
          {label}
        </Truncate>
      </span>
      {trailing != null ? <span className={s.sidebarTrailing}>{trailing}</span> : null}
    </button>
  );
}

/** A region with an optional header and a body that scrolls on its own. */
export function Panel(props: {
  header?: ReactNode;
  children: ReactNode;
  /** Pad the body with the standard 16 px. */
  padded?: boolean;
  /** Cap the body at the readable measure (prose columns: asks, settings). */
  measure?: boolean;
  /** Take the remaining height in a column. */
  fill?: boolean;
  className?: string | undefined;
  "aria-label"?: string;
}) {
  return (
    <section className={cx(s.panel, props.fill && s.fill, props.className)} aria-label={props["aria-label"]}>
      {props.header}
      <div className={cx(s.panelBody, props.padded && s.padded)}>
        {props.measure ? <div className={s.measure}>{props.children}</div> : props.children}
      </div>
    </section>
  );
}

/** A section's title line: title, count and a description, with actions that wrap below when space runs out. */
export function SectionHeader(props: {
  title: string;
  count?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A hairline under it (a pane header); off for headers inside a flow. */
  bordered?: boolean;
  as?: "h1" | "h2" | "h3";
  className?: string | undefined;
}) {
  const As = props.as ?? "h2";
  return (
    <div className={cx(s.sectionHeader, props.bordered && s.bordered, props.className)}>
      <div className={s.sectionTitles}>
        <div className={s.sectionTitleRow}>
          <As style={{ minWidth: 0, margin: 0, font: "inherit" }}>
            <Truncate strong>{props.title}</Truncate>
          </As>
          {props.count != null ? <span className={s.sectionCount}>{props.count}</span> : null}
        </div>
        {props.description ? (
          <Text size="xs" tone="quiet">
            {props.description}
          </Text>
        ) : null}
      </div>
      {props.actions ? <div className={s.sectionActions}>{props.actions}</div> : null}
    </div>
  );
}

/** A thin band of facts (the train strip, the machine strip). Items wrap onto a second line instead of clipping. */
export function Strip(props: { label?: string; children: ReactNode; edge?: "top" | "bottom"; className?: string | undefined; "aria-label"?: string }) {
  return (
    <div
      className={cx(s.strip, props.edge === "top" && s.stripTop, props.edge === "bottom" && s.stripBottom, props.className)}
      role="group"
      aria-label={props["aria-label"] ?? props.label}
    >
      {props.label ? <span className={s.stripLabel}>{props.label}</span> : null}
      {props.children}
    </div>
  );
}

/** One fact in a strip: an optional dot or icon, a label, a value. */
export function StripItem(props: { icon?: ReactNode; label: string; value?: ReactNode; title?: string; inRow?: boolean }) {
  return (
    <span className={s.stripItem} title={props.title}>
      {props.icon}
      <Truncate size="xs" tone="quiet" expand={props.inRow ? "none" : "popover"}>
        {props.label}
      </Truncate>
      {props.value != null ? <span className={s.stripValue}>{props.value}</span> : null}
    </span>
  );
}

/** An empty or error state: one headline, a sentence, and the action that gets out of it. */
export function EmptyState(props: { title: string; children?: ReactNode; actions?: ReactNode; tone?: "default" | "danger" }) {
  return (
    <div className={s.empty} role={props.tone === "danger" ? "alert" : undefined}>
      <Text as="h2" size="xl" strong tone={props.tone === "danger" ? "danger" : "default"}>
        {props.title}
      </Text>
      {props.children ? (
        <Text as="p" tone="quiet">
          {props.children}
        </Text>
      ) : null}
      {props.actions ? <div className={s.emptyActions}>{props.actions}</div> : null}
    </div>
  );
}
