// Screens (D305), a page of its own: every live and recent screen of the projects you can see, as a wall.
// What asks for you is on top, its picture large enough to read, with Take over beside it; then every live screen as a
// picture with its project, kind and machine, state, who has it and what its agent did last; then the ended ones as a
// list. New screen opens the same picker as a bot's Screens tab, its first pick the bot. The pictures are the
// hub's, a few a minute, and come only while the page shows (useThumbFeed).
//
// A screen opens on the page's own route (#/screens/<machine>/<project>/<id>): D278's view takes the page, with a way
// back to the wall.
import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, EmptyState, FrameTitle, Text, Truncate } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { useNow } from "../live/clock";
import { navigate } from "../shell/navigation";
import type { ProjectKey } from "../shell/routes";
import { setControl } from "../sessions/live";
import { SessionView } from "../sessions/SessionView";
import { isLive } from "../sessions/model";
import { NEW_SCREEN, openNewScreen } from "../sessions/NewScreen";
import { placeLine, split, useScreens, useThumbFeed, type PageScreen } from "./data";
import { Doing, Meta, openHref, openRoute, Thumb } from "./parts";
import s from "./page.module.css";

export function ScreensPage({ open }: { open: { project: ProjectKey; session: string } | null }) {
  const all = useScreens();
  const now = useNow(all.some((p) => isLive(p.x)));
  // Pictures only for the wall: an open screen's view has its own live frames.
  useThumbFeed(open === null);
  if (open !== null) {
    return (
      <div className={s.screen} data-screen="screens.view">
        <FrameTitle title="Screens" />
        <div className={s.viewWrap}>
          <SessionView key={open.session} project={open.project} id={open.session} onBack={() => navigate({ id: "screens", open: null })} />
        </div>
      </div>
    );
  }
  return <Wall all={all} now={now} />;
}

/** The title's quiet line: how many are live, and how many need you. */
export const countLine = (all: readonly PageScreen[]): string => {
  const { asking, live } = split(all);
  const n = asking.length + live.length;
  return `${String(n)} live${asking.length === 0 ? "" : ` · ${String(asking.length)} ${asking.length === 1 ? "needs" : "need"} you`}`;
};

function Heading({ title, count, tone = "quiet" }: { title: string; count: number; tone?: "quiet" | "warning" }) {
  return (
    <h2 className={s.heading}>
      <Text size="xs" tone={tone} strong>
        {title}
      </Text>
      <Text size="xs" tone="faint" tabular>
        {String(count)}
      </Text>
    </h2>
  );
}

function Wall({ all, now }: { all: readonly PageScreen[]; now: number }) {
  const { asking, live, recent } = split(all);
  const opens = useData((d) => d.features.includes(NEW_SCREEN));
  return (
    <div className={s.screen} data-screen="screens.page">
      {/* No "0 live" over a page that says it has none. */}
      <FrameTitle title="Screens" detail={all.length === 0 ? undefined : countLine(all)}>
        {opens ? (
          <Button variant="secondary" size="sm" icon={<Plus aria-hidden />} onClick={() => openNewScreen()}>
            New screen
          </Button>
        ) : null}
      </FrameTitle>
      <div className={s.body}>
        {all.length === 0 ? (
          // New screen only where there is one to press.
          <EmptyState title="No screens yet">
            {opens
              ? "When an agent opens a browser, a device or the agents’ Mac, or you open one with New screen, it shows here."
              : "When an agent opens a browser, a device or the agents’ Mac, it shows here."}
          </EmptyState>
        ) : null}
        {asking.length === 0 ? null : (
          <Group title="Needs you" count={asking.length} tone="warning">
            {asking.map((p) => (
              <AskingRow key={p.x.id} screen={p} now={now} />
            ))}
          </Group>
        )}
        {live.length === 0 ? null : (
          <Group title="Live" count={live.length}>
            <div className={s.grid}>
              {live.map((p) => (
                <Tile key={p.x.id} screen={p} now={now} />
              ))}
            </div>
          </Group>
        )}
        {recent.length === 0 ? null : (
          <Group title="Recent" count={recent.length}>
            <Recent recent={recent} now={now} />
          </Group>
        )}
      </div>
    </div>
  );
}

function Group({ title, count, tone, children }: { title: string; count: number; tone?: "quiet" | "warning"; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <Heading title={title} count={count} {...(tone === undefined ? {} : { tone })} />
      {children}
    </section>
  );
}

/** One that asks for you: its picture at a size to read, why it asks, and Take over beside it, which takes control and opens it. */
function AskingRow({ screen: p, now }: { screen: PageScreen; now: number }) {
  const layer = useDataLayer();
  return (
    <div className={s.asking} data-state={p.x.state}>
      <a className={s.askingPic} href={openHref(p)} aria-label={`Open ${p.x.purpose}`}>
        <Thumb screen={p} />
      </a>
      <div className={s.askingText}>
        <a className={s.titleLink} href={openHref(p)}>
          <Truncate size="md" strong expand="none">
            {p.x.purpose}
          </Truncate>
        </a>
        <Meta screen={p} now={now} />
        <span className={s.reason}>
          <Doing screen={p} />
        </span>
        <span className={s.askingActions}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void setControl(layer, p.x.id, "human");
              navigate(openRoute(p));
            }}
          >
            Take over
          </Button>
          <Text size="xs" tone="faint">
            opens it with you in control
          </Text>
        </span>
      </div>
    </div>
  );
}

/** A live one: whose it is and where it runs over its picture; what it is for, its state and who has it, and what its agent did last. */
function Tile({ screen: p, now }: { screen: PageScreen; now: number }) {
  return (
    <a className={s.tile} href={openHref(p)} data-state={p.x.state}>
      <span className={s.label}>
        <Text size="xs" tone="quiet">
          {p.project.title}
        </Text>
        <Text size="xs" tone="faint">
          {placeLine(p)}
        </Text>
      </span>
      <Thumb screen={p} />
      <span className={s.tileText}>
        <Truncate size="md" expand="none" className={s.purpose}>
          {p.x.purpose}
        </Truncate>
        <Meta screen={p} now={now} project={false} machine={false} />
        <span className={s.doing}>
          <Doing screen={p} />
        </span>
      </span>
    </a>
  );
}

/** How many ended ones Recent shows at first, and how many more each Show more adds. */
export const RECENT_STEP = 12;

/** The ended ones, newest first: the first RECENT_STEP, then RECENT_STEP more at each Show more. */
function Recent({ recent, now }: { recent: readonly PageScreen[]; now: number }) {
  const [shown, setShown] = useState(RECENT_STEP);
  const more = Math.min(RECENT_STEP, recent.length - shown);
  return (
    <div className={s.recent}>
      {recent.slice(0, shown).map((p) => (
        <RecentRow key={p.x.id} screen={p} now={now} />
      ))}
      {more > 0 ? (
        <span className={s.more}>
          <Button variant="quiet" size="sm" onClick={() => setShown((n) => n + RECENT_STEP)}>
            {`Show ${String(more)} more`}
          </Button>
          <Text size="xs" tone="faint" tabular>
            {`${String(shown)} of ${String(recent.length)}`}
          </Text>
        </span>
      ) : null}
    </div>
  );
}

/** An ended one, as a row: what it was for, then how it ended, who, where and when. */
function RecentRow({ screen: p, now }: { screen: PageScreen; now: number }) {
  return (
    <a className={s.recentRow} href={openHref(p)} data-state={p.x.state}>
      <Thumb screen={p} className={s.small} />
      <span className={s.recentText}>
        <Truncate size="md" expand="none" className={s.purposeEnded}>
          {p.x.purpose}
        </Truncate>
        <Meta screen={p} now={now} />
      </span>
    </a>
  );
}

