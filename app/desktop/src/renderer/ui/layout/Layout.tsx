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
 * traffic lights; without a sidebar the top row runs the full width and starts after them. `aside` is a panel on
 * the right, under the top row, as wide as its content says.
 */
export function AppFrame(props: {
  topBar: ReactNode;
  sidebar?: ReactNode;
  sidebarTop?: ReactNode;
  aside?: ReactNode;
  /** The window's own frame: its sidebar shows the window's translucent material where there is one (macOS). */
  translucent?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SetTitleSlot.Provider value={setSlot}>
      <TitleSlot.Provider value={slot}>
        <div className={cx(s.frame, !props.sidebar && s.noSidebar, Boolean(props.aside) && s.withAside, props.translucent && s.translucent, props.className)}>
          {props.sidebar ? (
            <div className={s.side}>
              <div className={s.sideTop}>{props.sidebarTop}</div>
              {props.sidebar}
            </div>
          ) : null}
          {props.topBar}
          <main className={s.main}>{props.children}</main>
          {props.aside ? <div className={s.aside}>{props.aside}</div> : null}
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
 * style. `title` is the page's name (its heading), `detail` a quiet line beside it (text, or a line of its own),
 * `lead` what comes before it (a way back), and `children` the page's controls and state, at the end.
 */
export function FrameTitle(props: { title?: string | undefined; detail?: ReactNode; lead?: ReactNode; children?: ReactNode }) {
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
        {props.detail == null ? null : typeof props.detail === "string" ? (
          <Truncate size="xs" tone="quiet" className={s.frameDetail}>
            {props.detail}
          </Truncate>
        ) : (
          props.detail
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
