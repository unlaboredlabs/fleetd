import { ChevronRight } from "lucide-react";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type TransitionEvent,
} from "react";
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
 * the right, from the very top too, as wide as its content says: its own first row sits beside the top row.
 * `corner` stays at the window's top right whether the aside shows or not (the panel's toggle, so a second click in
 * the same place undoes the first); the top row, or the aside's first row, leaves it room.
 *
 * The sidebar and the aside slide in from the window's edge as their toggle opens them and out to it as it closes
 * them (useSlide): the frame lays out once, at the toggle, and only their transform moves after it, so the chat
 * beside never lays out again mid-way. Anything else that brings or takes one (another screen) swaps it at once.
 */
export function AppFrame(props: {
  topBar: ReactNode;
  sidebar?: ReactNode;
  sidebarTop?: ReactNode;
  /** Whether the sidebar's toggle has it open: a change of it slides the sidebar; without it, any change does. */
  sidebarOpen?: boolean;
  aside?: ReactNode;
  /** Whether the aside's toggle has it open, as `sidebarOpen`. */
  asideOpen?: boolean;
  corner?: ReactNode;
  /** The window's own frame: its sidebar shows the window's translucent material where there is one (macOS). */
  translucent?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const side = useSlide(props.sidebarOpen, props.sidebar, props.sidebarTop);
  const aside = useSlide(props.asideOpen, props.aside);
  return (
    <SetTitleSlot.Provider value={setSlot}>
      <TitleSlot.Provider value={slot}>
        <div className={cx(s.frame, !props.sidebar && s.noSidebar, Boolean(props.aside) && s.withAside, Boolean(props.corner) && s.withCorner, props.translucent && s.translucent, props.className)}>
          {side.kept === null ? null : (
            <div className={s.side} {...side.attrs}>
              <div className={s.sideTop}>{side.kept[1]}</div>
              {side.kept[0]}
            </div>
          )}
          {props.topBar}
          <main className={s.main}>{props.children}</main>
          {aside.kept === null ? null : (
            <div className={s.aside} {...aside.attrs}>
              {aside.kept[0]}
            </div>
          )}
          {/* Last: Electron takes app-region boxes in document order, so the aside's drag row would cover it. */}
          {props.corner ? <div className={s.corner}>{props.corner}</div> : null}
        </div>
      </TitleSlot.Provider>
    </SetTitleSlot.Provider>
  );
}

/** Whether the element's transform moves now; without a transition (reduced motion, no styles) its end never comes. */
const moves = (el: HTMLElement): boolean => {
  const style = getComputedStyle(el);
  const longest = Math.max(0, ...style.transitionDuration.split(",").map((d) => (d.trim().endsWith("ms") ? parseFloat(d) : parseFloat(d) * 1000) || 0));
  return /\b(transform|all)\b/u.test(style.transitionProperty) && longest > 0;
};

/**
 * One side of the frame, by what it shows (the side itself first, then anything shown in it): `kept` is what to
 * render, null once it has gone. Shown, it is the nodes now; hidden by its toggle (`open`), the last ones shown, held
 * inert while it slides out. The frame's grid follows the props at once, so a side going out leaves its column as it
 * starts and is drawn over the main area's edge until it has gone. A side there at the frame's first render, or
 * brought or taken with its toggle unchanged, just comes or goes. The slide is a transition, so a toggle mid-way turns
 * it back from where it is.
 */
function useSlide(open: boolean | undefined, ...nodes: ReadonlyArray<ReactNode>) {
  const shown = Boolean(nodes[0]);
  const toggled = open ?? shown;
  const [was, setWas] = useState({ shown, toggled });
  const [motion, setMotion] = useState<"in" | "out" | null>(null);
  if (was.shown !== shown || was.toggled !== toggled) {
    setWas({ shown, toggled });
    if (was.shown !== shown) setMotion(was.toggled === toggled ? null : shown ? "in" : "out");
  }
  // The nodes of the last render that showed it, for its slide out: kept after each commit, so a render never
  // repeats itself to keep them.
  const last = useRef<ReadonlyArray<ReactNode>>([]);
  useLayoutEffect(() => {
    if (shown) last.current = nodes;
  });
  const el = useRef<HTMLDivElement>(null);
  const gone = useCallback(() => {
    last.current = [];
    setMotion(null);
  }, []);

  // Without a transition to wait for (reduced motion), it ends at once; a missed end, a moment after it.
  useLayoutEffect(() => {
    if (motion === null) return;
    const end = motion === "out" ? gone : () => setMotion(null);
    if (el.current === null || !moves(el.current)) {
      end();
      return;
    }
    const late = window.setTimeout(end, 400);
    return () => window.clearTimeout(late);
  }, [motion, gone]);

  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
    if (motion === "out") gone();
    else setMotion(null);
  };
  // `last` is read in the render a slide out starts, after the commit that last showed it wrote them; that render
  // comes from `motion`, which is state.
  /* eslint-disable react-hooks/refs */
  return {
    kept: shown ? nodes : motion === "out" ? last.current : null,
    attrs: { ref: el, "data-motion": motion ?? undefined, inert: motion === "out", onTransitionEnd },
  };
  /* eslint-enable react-hooks/refs */
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
/** `head` stands in for the title when it is more than words (a group that collapses); `label` names the section. */
export function SidebarSection(props: { title?: string; head?: ReactNode; label?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.sidebarSection} aria-label={props.label}>
      {props.title || props.head || props.action ? (
        <div className={s.sidebarSectionHead}>
          <span className={s.sidebarSectionTitle}>{props.head ?? (props.title ? <Truncate size="xs" tone="quiet">{props.title}</Truncate> : null)}</span>
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
  /** A chat's row (a project, a Navi): taller, for its avatar (layout.module.css .tall). */
  tall?: boolean;
}

/** One sidebar row, 28 px tall (a chat's, `tall`, fits its avatar): icon, a label that truncates with a tooltip, and trailing detail. */
export function SidebarItem({ label, icon, trailing, current, indent, emphasis, tall, className, ...rest }: SidebarItemProps) {
  return (
    <button
      type="button"
      className={cx(s.sidebarItem, indent && s.indent, tall && s.tall, className)}
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
