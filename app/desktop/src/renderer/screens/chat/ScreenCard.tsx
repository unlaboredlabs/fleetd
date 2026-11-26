// A screen of the bot's in its chat, where it opened (the phone's screen card, on the desktop and the web): its small
// picture, a few a minute while it is live (sessions/feed.ts), whose it is and its state, and one line under them, what
// it does now. While its agent asks for you the card says why in the warning's colour, with Take over, which takes it
// and opens it in the panel already yours. Once it ended it says how long it ran, with Replay. The picture and words
// open it in the panel (Watch). Once it ended, what its browser downloaded that the chat doesn't have yet is listed under
// it, each with Send to chat, for the day its machine keeps them. And the strip over the composer while one asks: who
// needs you, and Take over.
import { FileText, Globe, Hand, Laptop, Monitor, Play, Smartphone } from "lucide-react";
import { useState } from "react";
import type { ScreenDownload } from "../../../shared/contracts";
import { Button, StateGlyph, Text, Tooltip, Truncate, cx, toast } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { fmtBytes } from "./attachments";
import { projectKey } from "../../src/data/store";
import { useNow } from "../live";
import { setControl } from "../sessions/live";
import { glyphOf, isLive, type BrowserSession } from "../sessions/model";
import { useSessions } from "../sessions/hub";
import { useScreenFeed, useThumb } from "../sessions/feed";
import { navigate } from "../shell/navigation";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { askStrip, cardView, unsent } from "./screens";
import s from "./screenCard.module.css";
import v from "./view.module.css";

const sessionRoute = (x: BrowserSession) => panelRoute(x.projectRef, { tab: "sessions", session: x.id });

/** The bot's name, for whose screen it is: "grokdemo’s browser". */
const useBotTitle = (project: ProjectKey): string => useData((d) => d.projects[projectKey(project)]?.title ?? "The lead");

/** Takes the screen, then opens it in the panel, yours. */
function useTakeOver(x: BrowserSession | undefined): { readonly busy: boolean; readonly run: () => void } {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (x === undefined) return;
    setBusy(true);
    void setControl(layer, x.id, "human").then((ok) => {
      setBusy(false);
      if (ok) navigate(sessionRoute(x));
    });
  };
  return { busy, run };
}

const NO_DOWNLOADS: readonly ScreenDownload[] = [];

/** What its browser downloaded, as the hub lists it with the session. */
const useDownloads = (project: ProjectKey, sessionId: string): readonly ScreenDownload[] =>
  useToolQuery("browser_sessions", { projectRef: { machineId: project.machineId, projectId: project.projectId } }).data?.sessions.find((r) => r.sessionId === sessionId)?.downloads ??
  NO_DOWNLOADS;

/** `inChat`: the files the chat has had since the screen opened, by name. */
export function ScreenCard({ project, sessionId, inChat = [] }: { project: ProjectKey; sessionId: string; inChat?: readonly string[] }) {
  const x = useSessions(project).find((one) => one.id === sessionId);
  const downloads = useDownloads(project, sessionId);
  const live = x !== undefined && isLive(x);
  useScreenFeed(live);
  const bot = useBotTitle(project);
  // An ended one says how long it ran, which no longer moves; a live one says no time.
  const now = useNow(false);
  const take = useTakeOver(x);
  const thumb = useThumb(sessionId);
  if (x === undefined) return null;
  const card = cardView(x, bot, now);
  const offered = card.live ? [] : unsent(downloads, inChat, x, now);
  const href = toHash(sessionRoute(x));
  const phone = x.kind === "ios" || x.kind === "android";
  return (
    <div className={v.quietRow} data-entry="screen">
      <div className={cx(s.card, card.asking && s.asking, !card.live && s.ended)} data-screen-card={x.id} data-state={x.state}>
        <div className={s.main}>
          <a className={s.open} href={href} aria-label={`${card.action === "replay" ? "Replay" : "Watch"} ${card.title}: ${card.line}`}>
            <span className={cx(s.picture, phone && s.phone, thumb === undefined && s.blank)} data-kind={x.kind ?? "browser"}>
              {thumb === undefined ? <KindIcon kind={x.kind} /> : <img src={thumb} alt="" draggable={false} />}
              {card.asking ? (
                <span className={s.hand} aria-hidden>
                  <Hand />
                </span>
              ) : null}
            </span>
            <span className={s.words}>
              <span className={s.head}>
                <span className={s.title}>{card.title}</span>
                <span className={s.state}>
                  {card.live && !card.asking ? <StateGlyph state={glyphOf(x.state)} label={card.state} size="sm" phase={x.id.length % 4} /> : null}
                  <Text size="xs" tone={card.tone} strong={card.asking} tabular>
                    {card.state}
                  </Text>
                </span>
              </span>
              <Truncate size="xs" tone={card.asking ? "default" : "quiet"} lines={2} expand="none">
                {card.line}
              </Truncate>
            </span>
          </a>
          {card.action === "takeOver" ? (
            <Button variant="primary" size="sm" icon={<Hand aria-hidden />} disabled={take.busy} onClick={take.run}>
              Take over
            </Button>
          ) : card.action === "watch" ? (
            <Button variant="secondary" size="sm" onClick={() => navigate(sessionRoute(x))}>
              {x.state === "yours" ? "Open" : "Watch"}
            </Button>
          ) : card.action === "replay" ? (
            <Button variant="secondary" size="sm" icon={<Play aria-hidden />} onClick={() => navigate(sessionRoute(x))}>
              Replay
            </Button>
          ) : null}
        </div>
        {offered.length === 0 ? null : (
          <ul className={s.downloads} aria-label="Downloaded on this screen">
            {offered.map((d) => (
              <DownloadRow key={d.name} sessionId={x.id} download={d} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A file the screen's browser downloaded: its name and size, and Send to chat, which posts it as the lead's file card. */
function DownloadRow({ sessionId, download: d }: { sessionId: string; download: ScreenDownload }) {
  const layer = useDataLayer();
  const [step, setStep] = useState<"send" | "sending" | "sent">("send");
  const send = () => {
    setStep("sending");
    void layer.call("browser_download_send", { sessionId, name: d.name }).then((out) => {
      // Sent, it leaves the list as its message comes in; until then it says it went.
      setStep(out.ok ? "sent" : "send");
      if (!out.ok) toast({ title: `Couldn’t send ${d.name}`, description: out.error.message, key: `download:${sessionId}:${d.name}` });
    });
  };
  return (
    <li className={s.download}>
      <FileText aria-hidden className={s.fileIcon} />
      <span className={s.fileName}>{d.name}</span>
      <Text size="xs" tone="quiet" tabular>
        {fmtBytes(d.bytes)}
      </Text>
      <Button variant="link" disabled={step !== "send"} onClick={send} aria-label={`Send ${d.name} to the chat`}>
        {step === "sending" ? "Sending…" : step === "sent" ? "Sent" : "Send to chat"}
      </Button>
    </li>
  );
}

function KindIcon({ kind }: { kind: BrowserSession["kind"] }) {
  const Icon = kind === undefined ? Globe : kind === "ios" || kind === "android" ? Smartphone : kind === "mac" ? Laptop : Monitor;
  return <Icon aria-hidden className={s.kindIcon} />;
}

/**
 * Over the composer while one of the bot's screens asks for you, whatever the chat shows: who needs you, on what, and
 * Take over; a glass capsule beside the island, as what the lead waits on is.
 */
export function ScreenAsk({ project }: { project: ProjectKey }) {
  const sessions = useSessions(project);
  const bot = useBotTitle(project);
  const strip = askStrip(sessions, bot);
  const take = useTakeOver(strip?.session);
  if (strip === undefined) return null;
  return (
    <span className={cx(v.say, s.ask)} data-screen-ask={strip.session.id}>
      <Tooltip content={strip.session.handoff?.reason ?? strip.session.purpose}>
        <span className={s.askWords}>
          <Text size="xs" tone="warning" strong>
            {strip.title}
          </Text>
          {strip.more > 0 ? (
            <Text size="xs" tone="quiet" tabular>
              {` · ${String(strip.more)} more`}
            </Text>
          ) : null}
        </span>
      </Tooltip>
      <Button variant="link" disabled={take.busy} onClick={take.run}>
        Take over
      </Button>
    </span>
  );
}
