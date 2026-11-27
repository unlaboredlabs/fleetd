import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type TransitionEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight, PanelLeft } from "lucide-react";
import { cx } from "../lib/cx";
import { tabPlace } from "../lib/tabTitle";
import { StateGlyph } from "../primitives/StateGlyph";
import { Tooltip } from "../primitives/Tooltip";
import { Text } from "../text/Text";
import { Truncate } from "../text/Truncate";
import s from "./layout.module.css";

// The top row's middle, where the screen on show puts its title (FrameTitle): one header row, not two.
const TitleSlot = createContext<HTMLElement | null>(null);
const SetTitleSlot = createContext<(el: HTMLElement | null) => void>(() => undefined);

/**
 * The window: a sidebar flush down the left, its own soft tone (the macOS traffic lights sit in its first row), and
 * beside it the main area (which owns its own scrolling), with the top row floating over its top: no bar, just what the screen
 * puts there. `sidebarTop` is the sidebar's first row, beside the traffic lights; without a sidebar the top row starts
 * after them. `under` says the screen's content scrolls on under the top row (the chat), up to the window's edge, under
 * the row's glass. `aside` is a panel on the right, from the very top too, as wide as its content says: its own first row sits
 * beside the top row.
 *
 * The sidebar and the aside slide in from the window's edge as their toggle opens them and out to it as it closes
 * them (useSlide): the frame lays out once, at the toggle, and only their transform moves after it, so the chat
 * beside never lays out again mid-way. Anything else that brings or takes one (another screen) swaps it at once.
 * `sidebarEdge` sits on the sidebar's right edge, over the top row too, while the sidebar shows. `sidebarToggle` is the
 * sidebar's button, right of the traffic lights as in Finder and Notes: on macOS it stays put, in the sidebar's empty
 * first strip while it shows and before the top row's pill while it doesn't; elsewhere the sidebar's first row is its
 * own, so the button shows only while the sidebar is closed. Transparent until pointed at, over the see-through
 * sidebar as it slides; once the sidebar has gone, the button and the traffic lights float on one glass island, as the
 * pill beside them does.
 */
export function AppFrame(props: {
  topBar: ReactNode;
  sidebar?: ReactNode;
  sidebarTop?: ReactNode;
  /** Whether the sidebar's toggle has it open: a change of it slides the sidebar; without it, any change does. */
  sidebarOpen?: boolean;
  /** On the sidebar's right edge while it shows: what resizes it. */
  sidebarEdge?: ReactNode;
  /** The sidebar's show and hide button: what it runs, and the shortcut that does the same, for its tooltip. */
  sidebarToggle?: { readonly onPress: () => void; readonly shortcut: string } | undefined;
  aside?: ReactNode;
  /** Whether the aside's toggle has it open, as `sidebarOpen`. */
  asideOpen?: boolean;
  /** The screen's content scrolls under the top row rather than starting below it. */
  under?: boolean;
  /** A banner shows under the top row (the shell's): the row's fade stops at the row rather than run over it. */
  bannered?: boolean;
  /** The window's own frame: its sidebar shows the window's translucent material where there is one (macOS). */
  translucent?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const side = useSlide(props.sidebarOpen, props.sidebar, props.sidebarTop);
  const aside = useSlide(props.asideOpen, props.aside);
  const mainRef = useGlide(aside.attrs["data-motion"]);
  return (
    <SetTitleSlot.Provider value={setSlot}>
      <TitleSlot.Provider value={slot}>
        <div className={cx(s.frame, !props.sidebar && s.noSidebar, Boolean(props.sidebarToggle) && s.withToggle, Boolean(props.aside) && s.withAside, props.under && s.under, props.bannered && s.bannered, props.translucent && s.translucent, props.className)}>
          {side.kept === null ? null : (
            <div id="sidebar" className={s.side} {...side.attrs}>
              <div className={s.sideTop}>{side.kept[1]}</div>
              {side.kept[0]}
            </div>
          )}
          <main ref={mainRef} className={s.main}>{props.children}</main>
          {/* After the main area it floats over: Electron takes app-region boxes in document order, so the row's drag
              box and its controls' no-drag ones win over anything under them. */}
          {props.topBar}
          {/* After the top row: the edge reaches a few pixels over it, and a control under a drag box that comes after
              it loses its click (base.css). */}
          {props.sidebar && props.sidebarEdge ? <div className={s.sideEdge}>{props.sidebarEdge}</div> : null}
          {/* The window's controls on glass once the sidebar has gone, under the button that comes after it. Floating, as
              the top row does: what scrolls under its drag box does so by design. */}
          {props.sidebarToggle && side.kept === null ? <div className={s.controls} aria-hidden data-floats="" /> : null}
          {props.sidebarToggle ? <SidebarToggle {...props.sidebarToggle} shown={Boolean(props.sidebar)} /> : null}
          {aside.kept === null ? null : (
            <div className={s.aside} {...aside.attrs}>
              {aside.kept[0]}
            </div>
          )}
        </div>
      </TitleSlot.Provider>
    </SetTitleSlot.Provider>
  );
}

/** The sidebar's button: after the top row and the sidebar's first strip, so its no-drag box wins over their drag ones. */
function SidebarToggle(props: { onPress: () => void; shortcut: string; shown: boolean }) {
  const words = props.shown ? "Hide sidebar" : "Show sidebar";
  return (
    <Tooltip content={`${words} · ${props.shortcut}`} side="bottom">
      <button type="button" className={s.sideToggle} aria-label={words} aria-expanded={props.shown} aria-controls={props.shown ? "sidebar" : undefined} onClick={props.onPress}>
        <PanelLeft aria-hidden />
      </button>
    </Tooltip>
  );
}

/**
 * The main area's glide as the panel comes or goes: the frame lays the main area out once, at its new width, and its
 * content (centred, as the chat's is) would jump sideways by half the change. Instead it starts where it was and
 * glides to its place on the panel's own curve: a transform only, so it rewraps once, at the click, and nothing lays out
 * mid-way. The pill stays put: it sits at the main area's leading edge, which the panel never moves.
 */
function useGlide(motion: "in" | "out" | undefined) {
  const main = useRef<HTMLElement>(null);
  const width = useRef(0);
  // Its width as last laid out: a window resize keeps it current, and the effect below reads it before the observer
  // has seen the panel's change.
  useLayoutEffect(() => {
    const el = main.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => (width.current = el.getBoundingClientRect().width));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = main.current;
    if (el === null) return;
    const now = el.getBoundingClientRect().width;
    const was = width.current;
    width.current = now;
    if (motion === undefined || was === 0 || was === now || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const style = getComputedStyle(el);
    const duration = parseFloat(style.getPropertyValue(motion === "in" ? "--dur-panel-in" : "--dur-panel-out")) || 0;
    const easing = style.getPropertyValue("--ease-panel").trim() || "ease-out";
    const shift = (was - now) / 2;
    const runs: Animation[] = [];
    for (const m of el.children) {
      if (m instanceof HTMLElement) runs.push(m.animate([{ transform: `translateX(${String(shift)}px)` }, { transform: "none" }], { duration, easing }));
    }
    // While it glides the main area draws past its new edge (layout.module.css): the chat starts where it was, and its
    // right-hand bubbles show over the panel's column until the panel, drawn after it, slides over them, rather than
    // being cut at the edge for the frames before the panel reaches them.
    if (motion === "in" && runs.length > 0) {
      el.dataset["gliding"] = "";
      void Promise.allSettled(runs.map((r) => r.finished)).then(() => delete el.dataset["gliding"]);
    }
  }, [motion]);
  return main;
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
 * The top row over the main area, and the window's drag region: no bar, only what floats in it. It holds the current
 * screen's FrameTitle; buttons and fields inside stay clickable.
 */
export function TopBar(props: { className?: string }) {
  const setSlot = useContext(SetTitleSlot);
  return (
    <header className={cx(s.topBar, props.className)} data-floats="">
      <div ref={setSlot} className={s.topCenter} />
    </header>
  );
}

/** What a glass FrameTitle opens when it is a button (the chat's pill and its panel). */
export interface TitlePress {
  readonly onPress: () => void;
  /** What it opens shows now: the button stays pressed, its chevron turned back. */
  readonly pressed: boolean;
  readonly label: string;
  /** Its tooltip: what a click does, and the shortcut that does the same. */
  readonly tip: string;
  /** data-opens, as the app's other openers say what they open. */
  readonly opens: string;
  /** The id of what it opens, while it shows. */
  readonly controls: string;
}

/**
 * A screen's header, in the frame's top row rather than a header bar of the screen's own: every page's one header
 * style. `title` is the page's name (its heading), `detail` a quiet line beside it (text, or a line of its own),
 * `lead` what comes before it (a way back), and `children` the page's controls and state, at the end. `glass` floats
 * it as a capsule over a screen that scrolls under the top row (the chat), its controls then in Capsules of their own.
 * With `press` the glass capsule is a button (the chat's pill, which opens its panel): it reads as one at rest, by its
 * edge and a chevron towards where what it opens comes from, brightens under the pointer, gives a little as it is
 * pressed, and stays pressed, its chevron turned back, while what it opens shows.
 */
export function FrameTitle(props: { title?: string | undefined; detail?: ReactNode; lead?: ReactNode; glass?: boolean; press?: TitlePress | undefined; children?: ReactNode }) {
  const slot = useContext(TitleSlot);
  // The web's tab says the same place (ui/lib/tabTitle).
  useEffect(() => (props.title === undefined || props.title === "" ? undefined : tabPlace(props.title)), [props.title]);
  if (slot === null) return null;
  const press = props.press;
  const title =
    props.title === undefined ? null : press === undefined ? (
      <Truncate as="h1" strong className={s.frameHeading}>
        {props.title}
      </Truncate>
    ) : (
      // In a button, the name is its words: cut with an ellipsis, the whole of it in the button's label and tooltip.
      <span className={cx(s.frameHeading, s.pressName)}>{props.title}</span>
    );
  const detail =
    props.detail == null ? null : typeof props.detail === "string" ? (
      <Truncate size="xs" tone="quiet" className={s.frameDetail}>
        {props.detail}
      </Truncate>
    ) : (
      props.detail
    );
  return createPortal(
    <>
      {press === undefined ? (
        <span className={s.frameTitle} data-glass={props.glass === true ? "" : undefined}>
          {props.lead}
          {title}
          {detail}
        </span>
      ) : (
        <Tooltip content={press.tip} side="bottom">
          <button
            type="button"
            className={s.frameTitle}
            data-glass=""
            data-opens={press.opens}
            aria-pressed={press.pressed}
            aria-label={press.label}
            aria-controls={press.pressed ? press.controls : undefined}
            onClick={press.onPress}
          >
            {props.lead}
            {title}
            {detail}
            <ChevronRight className={s.pressChevron} aria-hidden />
          </button>
        </Tooltip>
      )}
      {props.children}
    </>,
    slot,
  );
}

/** A glass capsule in the top row, floating over what scrolls under it: a few of a screen's controls, together. */
export function Capsule({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <span className={cx(s.capsule, className)}>{children}</span>;
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
  /** A project's row: taller, for its avatar (layout.module.css .tall). */
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

/**
 * An empty or error state, the app's one layout for both, wherever it shows (a page, the panel, a pane): centred a
 * third of the way down, its mark (the list's own open ring on a tile unless given one, none for an error), one
 * headline, a sentence of what will show here or what went wrong, and the action that gets out of it.
 */
export function EmptyState(props: { title: string; children?: ReactNode; actions?: ReactNode; tone?: "default" | "danger"; mark?: ReactNode }) {
  const danger = props.tone === "danger";
  const mark =
    props.mark ??
    (danger ? null : (
      <span className={s.emptyTile}>
        <StateGlyph state="queued" still />
      </span>
    ));
  return (
    <div className={s.empty} role={danger ? "alert" : undefined} data-empty-state="">
      {mark === null ? null : (
        <span className={s.emptyMark} aria-hidden>
          {mark}
        </span>
      )}
      <Text as="h2" size="md" strong tone={danger ? "danger" : "default"}>
        {props.title}
      </Text>
      {props.children ? (
        <Text as="p" size="md" tone="quiet" className={s.emptyLine}>
          {props.children}
        </Text>
      ) : null}
      {props.actions ? <div className={s.emptyActions}>{props.actions}</div> : null}
    </div>
  );
}
