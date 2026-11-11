import { ChevronRight, Plus } from "lucide-react";
import { createContext, useContext, useId, type ReactElement, type ReactNode } from "react";
import { Button, cx, Dialog, Dot, FrameTitle, Text, Toggle, Tooltip, type ButtonProps, type TextTone } from "../../ui";
import { selectProjects } from "../../src/data/selectors";
import { useData } from "../../src/data/react";
import type { ProjectSummary } from "./contracts";
import type { Scope } from "./editor";
import { navigate } from "../shell/navigation";
import { useReveal } from "./search";
import s from "./settings.module.css";
import g from "./groups.module.css";

/** The hub's projects, for the pickers: the snapshot's, kept current by the data layer. Undefined until the
 * connection is fresh (not an empty list: an empty hub and one still loading must not look alike). */
export const useProjects = (): ReadonlyArray<ProjectSummary> | undefined => useData(selectProjects);

export function scopeName(scope: Scope, projects: ReadonlyArray<ProjectSummary> | undefined): string {
  if (scope.kind === "hub") return "Hub-wide";
  const p = projects?.find((x) => x.machineId === scope.ref.machineId && x.projectId === scope.ref.projectId);
  return p?.title ?? scope.ref.projectId;
}

/** Asks before a switch drops unsaved edits. */
export function ConfirmDiscard(props: { open: boolean; what: string; why: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onKeep()}
      title={`Discard your changes to ${props.what}?`}
      description={`They aren't saved. ${props.why}`}
      footer={
        <>
          <Button onClick={props.onKeep}>Keep editing</Button>
          <Button variant="danger" onClick={props.onDiscard}>
            Discard changes
          </Button>
        </>
      }
    />
  );
}

/**
 * The pages a set of tabs gathers (a project's, Every project's): the set's name and way back stand in the window's top
 * row for each page's own title, which its tab already says.
 */
export const PageFrame = createContext<{ title: string; lead?: ReactNode } | null>(null);

/**
 * Every Settings page's title, in the window's top row like every page's. A page has no line of description: its
 * title names it, and what there is to explain is the hint of the section or row it is about. What opens the page
 * instead is state the person needs now (`children`: the hub is too old for this page), with a control for the whole
 * page beside it (a full-size field, too tall for the top row). A page opened from another (a project's built-in
 * prompts, from its Instructions) names its way back in `lead`.
 */
export function PageHead(props: { title: string; lead?: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  const frame = useContext(PageFrame);
  return (
    <>
      <FrameTitle title={frame?.title ?? props.title} lead={frame?.lead ?? props.lead} />
      {props.children || props.aside ? (
        <div className={s.pageIntro}>
          {/* With no words, the control still sits at the row's right end. */}
          {props.children ? <Text tone="quiet">{props.children}</Text> : <span />}
          {props.aside}
        </div>
      ) : null}
    </>
  );
}

/** In place of a project's page while the hub has no project. */
export function NoProject() {
  const projects = useProjects();
  if (projects === undefined) return <Text tone="quiet">Loading…</Text>;
  return (
    <div className={s.inline}>
      <Text tone="quiet">No projects yet.</Text>
      <Button size="sm" onClick={() => navigate({ id: "projects.add" })}>
        New project
      </Button>
    </div>
  );
}

// ---- Layout A, soft groups (DESIGN.md, Settings): every Settings page is built from these, and has no rows, lines or
// cards of its own. A section is a quiet label over one soft group; a row is a title and one control at its right
// end; nothing draws a line between rows. What explains a row or a section is its `hint`; the quiet line under a
// title (`line`, `intro`) is only for state the person needs now.

const said = (hint: ReactNode): boolean => hint !== undefined && hint !== null && hint !== false && hint !== "";

/**
 * The one way a Settings page explains itself: `hint` is what would otherwise be small text under a title. It shows
 * under the title, in the app's tooltip, while the pointer rests on `children` (a row's title and control, a
 * section's label, a list's row) or keyboard focus is inside it, and leaves on Escape, a press or the pointer going.
 * Screen readers get the same words from the page itself (`HintWords`), not from the tooltip.
 */
function Hinted(props: { hint: ReactNode; children: ReactElement }) {
  return (
    <Tooltip content={said(props.hint) ? props.hint : null} side="bottom" align="start" offset={HINT_INSET} gap={-6} prose>
      {props.children}
    </Tooltip>
  );
}
/** The tooltip's words start where the title's do: the row's inset less the tooltip's own. */
const HINT_INSET = 6;

/** A hint that explains several choices (a row of radios): one short line each, the choice's name first. */
export function HintLines(props: { lines: ReadonlyArray<readonly [name: string, what: ReactNode] | string> }) {
  return (
    <>
      {props.lines.map((line) =>
        typeof line === "string" ? (
          <span key={line} className={g.hintLine}>
            {line}
          </span>
        ) : (
          <span key={line[0]} className={g.hintLine}>
            <strong>{line[0]}</strong>
            {": "}
            {line[1]}
          </span>
        ),
      )}
    </>
  );
}

/** A hint's words in the page, unseen: what `aria-describedby` names, and what a screen reader reads after the title. */
function HintWords(props: { id: string; hint: ReactNode }) {
  return said(props.hint) ? (
    <span id={props.id} className={s.srOnly} data-hint="">
      {props.hint}
    </span>
  ) : null;
}

/**
 * One section of a page: its quiet label, then its rows in one soft group. What the section is for is its `hint`, on
 * the label (which then takes keyboard focus); `intro` is a line under the label for state only (a warning, why the
 * section can't be changed). A search or a link for `reveal` lands on it; a section that search finds by an option
 * inside it names itself with `part` instead, so one place is one search result. No `title` when it is the page's
 * first or only section, which the page title names. `aside` sits at the label's right end: a section's plus. `bare`
 * holds what is not rows (a long editor, a form that opens in place) without the group's fill.
 */
export function SettingsSection(props: {
  title?: string | undefined;
  reveal?: string | undefined;
  part?: string | undefined;
  hint?: ReactNode | undefined;
  intro?: ReactNode | undefined;
  aside?: ReactNode | undefined;
  bare?: boolean | undefined;
  children?: ReactNode | undefined;
  /** Marks for tests and the QA screens (`data-…`). */
  data?: Readonly<Record<`data-${string}`, string | undefined>> | undefined;
}) {
  const ref = useReveal<HTMLElement>(props.reveal ?? "");
  const hintId = useId();
  const hinted = props.title !== undefined && said(props.hint);
  const head = props.title !== undefined || props.intro !== undefined || props.aside !== undefined;
  return (
    <section
      ref={ref}
      className={g.section}
      aria-label={props.title}
      aria-describedby={hinted ? hintId : undefined}
      data-part={props.reveal ?? props.part}
      tabIndex={-1}
      {...props.data}
    >
      {head ? (
        <div className={g.head}>
          <div className={g.headText}>
            {props.title === undefined ? null : (
              <Hinted hint={hinted ? props.hint : null}>
                <Text as="h2" size="sm" strong tone="quiet" className={g.label} {...(hinted ? { tabIndex: 0 } : {})}>
                  {props.title}
                </Text>
              </Hinted>
            )}
            {hinted ? <HintWords id={hintId} hint={props.hint} /> : null}
            {props.intro === undefined || props.intro === null ? null : (
              <Text size="sm" tone="quiet">
                {props.intro}
              </Text>
            )}
          </div>
          {props.aside}
        </div>
      ) : null}
      {props.children === undefined || props.children === null || props.children === false ? null : (
        <div className={props.bare === true ? g.bare : g.group}>{props.children}</div>
      )}
    </section>
  );
}

/**
 * One option in a section's group: its title on the left, its one `control` at the right end. At rest that is all of
 * it. What explains the option is its `hint`. `line`, the quiet line under the title, is only for state the person
 * needs now: a current value, an error, a warning before something that can't be undone, or why the control is off
 * and how to turn it on. What a row holds that is more than a control (a list, a form) is its children, full width
 * under the title. A search for `reveal` lands on it. A hinted row with no control beside its title takes keyboard
 * focus on the title, so the hint is in reach of the keyboard as well.
 */
export function SettingsRow(props: {
  reveal?: string | undefined;
  title: ReactNode;
  /** The row's name for assistive tech and tests, when `title` isn't plain words. */
  label?: string | undefined;
  hint?: ReactNode | undefined;
  line?: ReactNode | undefined;
  lineTone?: TextTone | undefined;
  control?: ReactNode | undefined;
  children?: ReactNode | undefined;
  /** The title's id, for a control that names itself by it (aria-labelledby). */
  titleId?: string | undefined;
  /** The hint's id, for a control that describes itself by it (aria-describedby). */
  hintId?: string | undefined;
  /** Marks for tests and the QA screens (`data-…`). */
  data?: Readonly<Record<`data-${string}`, string | undefined>> | undefined;
}) {
  const ref = useReveal<HTMLElement>(props.reveal ?? "");
  const own = useId();
  const hintId = props.hintId ?? own;
  const label = props.label ?? (typeof props.title === "string" ? props.title : undefined);
  const stop = said(props.hint) && props.control === undefined;
  return (
    <section ref={ref} className={g.row} aria-label={label} aria-describedby={said(props.hint) ? hintId : undefined} tabIndex={-1} {...props.data}>
      <Hinted hint={props.hint}>
        <div className={g.rowHead}>
          <div className={g.rowText}>
            <Text {...(props.titleId === undefined ? {} : { id: props.titleId })} {...(stop ? { tabIndex: 0, className: g.title } : {})}>
              {props.title}
            </Text>
            <HintWords id={hintId} hint={props.hint} />
            {props.line === undefined || props.line === null || props.line === false ? null : (
              <Text size="sm" tone={props.lineTone ?? "quiet"}>
                {props.line}
              </Text>
            )}
          </div>
          {props.control === undefined ? null : <div className={g.control}>{props.control}</div>}
        </div>
      </Hinted>
      {props.children === undefined || props.children === null || props.children === false ? null : <div className={g.below}>{props.children}</div>}
    </section>
  );
}

/** A row whose one control is a switch: the row's title is the switch's own words, so nothing is said twice. */
export function SwitchRow(props: {
  reveal?: string | undefined;
  title: string;
  hint?: ReactNode | undefined;
  line?: ReactNode | undefined;
  lineTone?: TextTone | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  onCheckedChange: (on: boolean) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <SettingsRow
      reveal={props.reveal}
      title={<label htmlFor={id}>{props.title}</label>}
      label={props.title}
      hint={props.hint}
      hintId={hintId}
      line={props.line}
      lineTone={props.lineTone}
      control={
        <Toggle
          id={id}
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={said(props.hint) ? hintId : undefined}
          onCheckedChange={props.onCheckedChange}
        />
      }
    />
  );
}

/**
 * One row of a list in a group (People, Machines, Devices, a project's repos): a glyph, the name with what it is beside
 * it, quiet lines under it for what it is now (never what it means: that is its `hint`, as a row's), and its controls
 * at the right end. A state is its word, coloured (`state`). A row that
 * only needs someone says so with one dot at its end instead (`needs`), why in its tooltip, as the sidebar's rows
 * do; never both. With `open`, the whole row opens what it names, and a chevron trails it; a row that unfolds rows
 * under it instead says so with `expanded`, and its chevron turns down while they show.
 */
export function SettingsListRow(props: {
  name: ReactNode;
  /** The row's name for assistive tech and tests. */
  label: string;
  icon?: ReactNode | undefined;
  /** A quiet word beside the name ("you", a role). */
  meta?: ReactNode | undefined;
  state?: { word: string; tone: TextTone } | undefined;
  hint?: ReactNode | undefined;
  /** In place of `state`: why the row needs someone, as one dot at the row's end; the words are its name and the row's tooltip. */
  needs?: string | undefined;
  children?: ReactNode | undefined;
  controls?: ReactNode | undefined;
  open?: { href: string } | { onClick: () => void } | undefined;
  expanded?: boolean | undefined;
  /** Marks for tests and the QA screens (`data-…`). */
  data?: Readonly<Record<`data-${string}`, string | undefined>> | undefined;
}) {
  const name = <Text>{props.name}</Text>;
  const hintId = useId();
  return (
    <Hinted hint={props.hint}>
      <div
        className={cx(g.listRow, props.icon !== undefined && g.withIcon, props.open !== undefined && g.opens)}
        role="listitem"
        aria-label={props.label}
        aria-describedby={said(props.hint) ? hintId : undefined}
        {...props.data}
      >
        {props.icon === undefined ? null : (
          <span className={g.icon} aria-hidden>
            {props.icon}
          </span>
        )}
        <div className={g.rowText}>
          <div className={g.name}>
            {props.open === undefined ? (
              name
            ) : "href" in props.open ? (
              <a className={g.opener} href={props.open.href} title={props.needs}>
                {name}
              </a>
            ) : (
              <button type="button" className={g.opener} aria-expanded={props.expanded} onClick={props.open.onClick} title={props.needs}>
                {name}
              </button>
            )}
            {props.meta === undefined || props.meta === null ? null : <Text size="sm" tone="quiet">
                {props.meta}
              </Text>}
            {props.state === undefined ? null : (
              <Text size="sm" tone={props.state.tone}>
                {props.state.word}
              </Text>
            )}
            <HintWords id={hintId} hint={props.hint} />
          </div>
          {props.children}
        </div>
        {props.controls === undefined && props.open === undefined && props.needs === undefined ? null : (
          <div className={g.control}>
            {props.needs === undefined ? null : (
              <span className={g.needs}>
                <Dot color="var(--warning)" label={props.needs} />
              </span>
            )}
            {props.controls}
            {props.open === undefined ? null : <ChevronRight className={g.chevron} data-open={props.expanded === true ? "" : undefined} aria-hidden />}
          </div>
        )}
      </div>
    </Hinted>
  );
}

/** A list's rows in their group: no lines between them. `nested`: the rows a row of another list unfolds, set in under it. */
export function SettingsList(props: { label: string; nested?: boolean | undefined; children: ReactNode }) {
  return (
    <div className={cx(g.list, props.nested === true && g.nested)} role="list" aria-label={props.label}>
      {props.children}
    </div>
  );
}

/** Add is a plus, at the end of its row or its section's label; its words are its name and tooltip. */
export function AddButton({ label, ...rest }: Omit<ButtonProps, "children" | "iconOnly" | "variant"> & { label: string }) {
  return (
    <Button variant="ghost" iconOnly aria-label={label} title={label} className={g.add} {...rest}>
      <Plus size={16} aria-hidden />
    </Button>
  );
}

/** Danger is one red pill: Delete project, Remove machine. What it does is confirmed in a dialog. */
export function DangerButton({ className, ...rest }: Omit<ButtonProps, "variant">) {
  return <Button variant="danger" className={cx(g.danger, className)} {...rest} />;
}

/** Words a group holds that aren't a row, and only state: Loading…, an empty list, an error. Never an explanation. */
export function GroupNote(props: { tone?: TextTone | undefined; children: ReactNode }) {
  return (
    <Text className={g.note} tone={props.tone ?? "quiet"}>
      {props.children}
    </Text>
  );
}

