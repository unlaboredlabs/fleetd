// The Screens page's parts: a screen's picture (Thumb), its state and who drives it in one line (Meta), what its agent
// did last (Doing), and where it opens (the page's own route, so the view gets the page's room).
import { Globe, Laptop, Monitor, Smartphone } from "lucide-react";
import { StateGlyph, Text, Truncate, cx } from "../../ui";
import { RolePill } from "../agents/parts";
import { agoText } from "../projects/machineText";
import { parseMs } from "../live/format";
import { durationOf, fmtDuration, glyphOf, isLive, STATE_TONE, STATE_WORD } from "../sessions/model";
import { toHash, type Screen } from "../shell/routes";
import { isPhone, KIND_WORD, placeLine, type PageScreen } from "./data";
import s from "./page.module.css";

/** The page with one screen open: the view, live or its replay. */
export const openRoute = (p: PageScreen): Screen => ({ id: "screens", open: { project: p.x.projectRef, session: p.x.id } });
export const openHref = (p: PageScreen): string => toHash(openRoute(p));

/**
 * Its picture at the size the design gives it: a browser's, a desktop's or the Mac's fills the frame; a phone stands
 * up in the middle of it, its own corners round. None yet (starting, lost, expired), the kind in a word.
 */
export function Thumb({ screen: p, className }: { screen: PageScreen; className?: string | undefined }) {
  const phone = isPhone(p.kind);
  return (
    <span className={cx(s.thumb, phone && s.phoneThumb, !isLive(p.x) && s.thumbEnded, p.thumb === undefined && s.blank, className)} data-kind={p.kind}>
      {p.thumb === undefined ? (
        <span className={s.noThumb}>
          <KindIcon kind={p.kind} />
          <Text size="xs" tone="faint">
            {p.x.state === "lost" ? "recording lost" : p.x.state === "expired" ? "expired" : p.x.state === "saving" ? "saving" : KIND_WORD[p.kind]}
          </Text>
        </span>
      ) : (
        <img src={p.thumb} alt="" draggable={false} />
      )}
    </span>
  );
}

function KindIcon({ kind }: { kind: PageScreen["kind"] }) {
  const Icon = kind === "browser" ? Globe : isPhone(kind) ? Smartphone : kind === "mac" ? Laptop : Monitor;
  return <Icon aria-hidden className={s.kindIcon} />;
}

/** Its glyph and state in words, then who has it, the project, where it runs; the time at the end. */
export function Meta({ screen: p, now, project = true, machine = true, time = true }: { screen: PageScreen; now: number; project?: boolean; machine?: boolean; time?: boolean }) {
  const x = p.x;
  const ended = parseMs(x.endedAt);
  const mine = x.openedBy !== undefined;
  return (
    <span className={s.meta}>
      <span className={s.state}>
        <StateGlyph state={glyphOf(x.state)} label={STATE_WORD[x.state]} phase={x.id.length % 4} />
        <Text size="xs" tone={STATE_TONE[x.state]} strong={x.state === "asking" || x.state === "yours"}>
          {STATE_WORD[x.state]}
        </Text>
      </span>
      {p.project.navi && !mine ? null : mine ? (
        x.state === "yours" ? null : (
          <Text size="xs" tone="quiet">
            {x.openedBy}
          </Text>
        )
      ) : x.agent.role === undefined ? (
        <Truncate size="xs" tone="quiet" expand="none">
          {x.agent.title}
        </Truncate>
      ) : (
        <span className={s.who}>
          <RolePill role={x.agent.role} />
          <Truncate size="xs" tone="quiet" expand="none">
            {x.agent.title}
          </Truncate>
        </span>
      )}
      {project ? (
        <span className={s.where}>
          <Text size="xs" tone="quiet">
            {p.project.title}
          </Text>
        </span>
      ) : null}
      {machine ? (
        <span className={s.where}>
          <Text size="xs" tone="faint">
            {placeLine(p)}
          </Text>
        </span>
      ) : null}
      {time ? (
        <span className={s.time}>
          <Text size="xs" tone="faint" tabular>
            {ended === undefined ? fmtDuration(durationOf(x, now)) : `${fmtDuration(durationOf(x, now))} · ${agoText(now - ended)}`}
          </Text>
        </span>
      ) : null}
    </span>
  );
}

/** What its agent did last, why it asks you, or what you can do with it: one quiet line. */
export function Doing({ screen: p }: { screen: PageScreen }) {
  const x = p.x;
  if (x.state === "asking" && x.handoff !== undefined) {
    return (
      <Truncate size="xs" tone="warning" lines={2} expand="none">
        {x.handoff.reason}
      </Truncate>
    );
  }
  if (!isLive(x)) return null;
  const line = x.state === "yours" && x.openedBy !== undefined ? (p.doing === undefined ? "Yours to drive" : `Yours to drive · ${p.doing}`) : p.doing;
  if (line === undefined) return null;
  return (
    <Truncate size="xs" tone="quiet" expand="none">
      {line}
    </Truncate>
  );
}
