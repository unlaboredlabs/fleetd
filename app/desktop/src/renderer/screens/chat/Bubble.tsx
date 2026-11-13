// A message as bubbles: the lead's on the left, yours on the right in the accent, a run from one author drawn as one
// stack, its inner corners tight. A lead message the hub split shows one bubble per part, its blocks as
// cards. While the lead writes, a typing bubble stands in for the text. Hovering a bubble shows its time and, on the
// lead's, a tapback and Reply; right-clicking one copies it, and on the lead's replies or reacts too. A reply of yours
// shows the bubble it answers above it.
import { Check, Paperclip, Reply, Send, SmilePlus, Tag } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { AttachmentRef } from "../../../shared/contracts";
import { PREVIEW_SIDE } from "../../../shared/transfer";
import type { ChatItem } from "../../src/data/chat";
import { useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { useSeen } from "../live";
import {
  Button,
  ContextMenu,
  ContextMenuCopy,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  cx,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Text,
  Tooltip,
  Truncate,
  useBeatRef,
} from "../../ui";
import { useBubbleActions } from "./actions";
import { fmtBytes, imageFit, pngDensity } from "./attachments";
import { FileCard } from "./blocks/FileCard";
import { ImageViewer, ImageViewerContext, useOpenImage } from "./ImageViewer";
import { Block } from "./blocks/Block";
import { bubblesOf, isWide, quoteOf, TAPBACK_WORD, TAPBACKS, tapbackSend, unshownOnly, type Bubble, type Tapback } from "./bubbles";
import { MessageReceipt, ReceiptMarkView } from "./Composer";
import { shortClock } from "./format";
import { authorLabel, ENTER_MS, isMineRow, viaOf, type Arrival, type Row } from "./model";
import { Picture } from "./picture";
import { plainText } from "./plain";
import { useLooked } from "./looked";
import { shotsOf } from "./shots";
import { markOf, useShown } from "./shown";
import type { ProjectRef } from "./slots";
import { bubbleKey, toggleTapback, useTapbacks } from "./tapbacks";
import { Message } from "./text";
import { TagLine } from "./lens/Lens";
import { aboutOf, partAbout } from "./lens/tags";
import s from "./view.module.css";

/**
 * An attachment as a chip. A file name is a machine token (pasted-1.txt, receipt-dates.png): the code voice, cut to
 * fit.
 */
function FileChip({ file, box }: { file: AttachmentRef; box?: (el: Element | null) => void }) {
  return (
    <span ref={box} className={s.attachment}>
      <Paperclip className={s.attachmentIcon} aria-hidden />
      <span className={s.attachmentName} data-text="code">
        <Truncate size="sm" mono>
          {file.name}
        </Truncate>
      </span>
      <Text size="xs" tone="quiet" tabular>
        {fmtBytes(file.bytes)}
      </Text>
    </span>
  );
}

// An image shows its preview, fetched once its chip has been on screen (the list mounts rows it drops again at once
// while it measures, and those never read), and opens large when clicked; its own button and menu save or copy it
// (picture.tsx). Until then, and if it can't be read, it is a file like any other.
// It shows at its size in points (a Retina screenshot at half its pixels) within IMAGE_MAX, whatever its pixels, so it
// sits in its side's corner like the bubble above it. A preview fits PREVIEW_SIDE.desktop, twice the box, so it fills
// the box as the picture would, sharp on a Retina screen; a picture smaller than that comes as itself.
function ImageAttachment({ project, file }: { project: ProjectRef; file: AttachmentRef }) {
  const [seen, box] = useSeen();
  const got = useToolQuery("attachment_get", { projectRef: project, attachmentId: file.attachmentId, maxSide: PREVIEW_SIDE.desktop }, { enabled: seen });
  const open = useOpenImage();
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const dataB64 = got.data?.dataB64;
  const density = useMemo(() => (dataB64 !== undefined && got.data?.mime === "image/png" ? pngDensity(dataB64) : 1), [dataB64, got.data?.mime]);
  if (got.data === undefined) return <FileChip file={file} box={box} />;
  const img = (
    <img
      className={s.attachmentImage}
      src={`data:${got.data.mime};base64,${got.data.dataB64}`}
      alt={file.name}
      title={file.name}
      style={size}
      onLoad={(e) => setSize(imageFit(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight, density))}
    />
  );
  return (
    <Picture project={project} file={file}>
      {open === undefined ? (
        img
      ) : (
        <button type="button" className={s.attachmentOpen} onClick={() => open(file.attachmentId)} aria-label={`Open ${file.name}`}>
          {img}
        </button>
      )}
    </Picture>
  );
}

// Any other file is a card that opens or saves it, as a lead's own files are.
function Attachment({ project, file }: { project: ProjectRef; file: AttachmentRef }) {
  return file.mime.startsWith("image/") ? <ImageAttachment project={project} file={file} /> : <FileCard project={project} file={file} />;
}

/** A reply's bubbles enter a step apart, up to this many steps: a long one doesn't keep you waiting for its last. */
const MAX_STEP = 5;

/**
 * A line that came in while the chat was open (arrivalsOf) enters as it mounts, `step` places into its message. One
 * remounted soon after (the list dropping and remounting it) picks the motion up where it was; one mounted later
 * (scrolled back to) is still. Your send keeps its row as the hub confirms it (rowKeyOf), so it enters once.
 */
export function useEnter(arrival: Arrival | undefined, step = 0): { className?: string | undefined; style?: CSSProperties | undefined } {
  const [since] = useState(() => (arrival === undefined ? undefined : Date.now() - arrival.at));
  if (arrival === undefined || since === undefined || since >= ENTER_MS) return {};
  const style = { "--enter-step": Math.min(arrival.step + step, MAX_STEP), "--enter-since": `${String(since)}ms` } as CSSProperties;
  return { className: s.enter, style };
}

/** One to three emoji and nothing else: shown large, without a bubble, as a messaging app does. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*\s*){1,3}$/u;

/** The lead writing: three square cells, one lit at a time, on the app's beat (view.module.css). */
function TypingBubble() {
  const dots = useBeatRef<HTMLSpanElement>(true);
  return (
    <div className={cx(s.bubble, s.theirs, s.first, s.last)} role="status" aria-label="The lead is writing" data-typing>
      <span ref={dots} className={s.typing} aria-hidden>
        {[0, 1, 2].map((d) => (
          <span key={d} className={s.dot} />
        ))}
      </span>
    </div>
  );
}

function TapbackPicker({ current, onPick }: { current: Tapback | undefined; onPick: (t: Tapback) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Tapback">
        <PopoverTrigger asChild>
          <Button variant="quiet" iconOnly aria-label="Tapback">
            <SmilePlus />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      {/* Above the bubble, or below it when there's no room above. Once the bubble scrolls out of the chat the
          picker hides with it rather than following it past the window's edge. Gone the moment it closes, as a
          tooltip is: left to Radix, a closed picker stays until its entrance reports an end that may never come. */}
      {open ? (
        <PopoverContent side="top" hideWhenDetached aria-label="Tapbacks">
          <div className={s.picker}>
            {TAPBACKS.map((t) => (
              <button
                key={t}
                type="button"
                className={s.pick}
                aria-label={TAPBACK_WORD[t]}
                aria-pressed={current === t}
                title={TAPBACK_WORD[t]}
                onClick={() => {
                  setOpen(false);
                  onPick(t);
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function BubbleLine(props: {
  item: ChatItem;
  bubble: Bubble;
  first: boolean;
  last: boolean;
  /** The lead's: it takes tapbacks and replies. */
  lead: boolean;
  answer: string | undefined;
  tapback: Tapback | undefined;
  enter: Arrival | undefined;
  /** Its place in the message, for the stagger as the message enters. */
  step: number;
  /** The message's first bubble. */
  opening: boolean;
  /** Yours: drawn as your side of the chat. */
  mine: boolean;
  /** Your message's last bubble: its receipt mark goes beside it; true when it's your latest message. */
  receipt?: boolean | undefined;
  /** The last bubble of the reply a turn ended with: how long the turn took, a quiet stamp beside it. */
  worked?: string | undefined;
}) {
  const { item, bubble, first, last, lead, mine } = props;
  const actions = useBubbleActions();
  const enter = useEnter(props.enter, props.step);
  const block = bubble.kind === "block";
  const wide = isWide(bubble);
  const jumbo = !block && EMOJI_ONLY.test(bubble.text.trim());
  // A lead's block that didn't show: its chip, without a bubble around it.
  // Only a lead's or agent's words hold blocks; a person's fleetd-block fence is code they wrote.
  const blocks = item.author !== "human";
  const bare = jumbo || (blocks && !block && unshownOnly(bubble.text));
  // A mark on the message as a whole (a nudge's Show) rings its first bubble.
  const mark = markOf(actions?.shown, item.id, bubble.key) ?? (props.opening ? markOf(actions?.shown, item.id) : undefined);
  const box = useRef<HTMLDivElement>(null);
  const shown = useShown(box, mark);
  const pick = (t: Tapback) => {
    if (actions === undefined) return;
    const was = props.tapback;
    toggleTapback(projectKey(actions.project), bubbleKey(item.id, bubble.key), t);
    // Taking a 👍 off never sends anything; putting one on may answer.
    if (was === t) return;
    const send = tapbackSend(t, bubble, actions.waitedOn === item.id, props.answer === undefined);
    if (send !== undefined) actions.send(send.text);
  };
  const reply = () => actions?.reply({ id: item.id, part: Number(bubble.key), quote: quoteOf(bubble.text) });
  const words = bubble.text.trim() !== "";
  const answers = lead && actions !== undefined;
  // A tagged chat's About…: any message the hub has, moved to an open order or to none.
  const tags = actions?.tags;
  const retags = tags !== undefined && item.message !== undefined && item.state !== "streaming";
  // Of a message about several orders, this bubble's.
  const about = partAbout(item, bubble.key)?.workstreamId ?? aboutOf(item);
  const menu = () => (
    <>
      {words ? (
        <>
          <ContextMenuCopy text={plainText(bubble.text)}>Copy text</ContextMenuCopy>
          <ContextMenuCopy text={bubble.text.trim()}>Copy as Markdown</ContextMenuCopy>
        </>
      ) : null}
      {words && answers ? <ContextMenuSeparator /> : null}
      {answers ? (
        <>
          <ContextMenuItem icon={<Reply />} onSelect={reply}>
            Reply
          </ContextMenuItem>
          <ContextMenuSub label="React" icon={<SmilePlus />}>
            {TAPBACKS.map((t) => (
              <ContextMenuItem key={t} icon={<span aria-hidden>{t}</span>} hint={props.tapback === t ? <Check aria-label="On" /> : undefined} onSelect={() => pick(t)}>
                {TAPBACK_WORD[t]}
              </ContextMenuItem>
            ))}
          </ContextMenuSub>
        </>
      ) : null}
      {retags && (words || answers) ? <ContextMenuSeparator /> : null}
      {retags ? (
        <ContextMenuSub label="About…" icon={<Tag />}>
          {tags.open.map((o) => (
            <ContextMenuItem key={o.workstreamId} hint={about === o.workstreamId ? <Check aria-label="On" /> : undefined} onSelect={() => tags.retag(item.id, o.workstreamId)}>
              {o.title}
            </ContextMenuItem>
          ))}
          {tags.open.length > 0 ? <ContextMenuSeparator /> : null}
          <ContextMenuItem hint={about === undefined ? <Check aria-label="On" /> : undefined} onSelect={() => tags.retag(item.id, undefined)}>
            Nothing
          </ContextMenuItem>
        </ContextMenuSub>
      ) : null}
    </>
  );
  return (
    <div className={cx(s.line, wide && s.wide, props.tapback !== undefined && s.reacted, enter.className)} style={enter.style}>
      <ContextMenu menu={menu} disabled={!words && !answers && !retags}>
        <div
          ref={box}
          // Focusable from script while it is what Show went to; not a tab stop of its own.
          tabIndex={shown ? -1 : undefined}
          className={cx(
            !block && !bare && s.bubble,
            !block && !bare && (mine ? s.mineBubble : s.theirs),
            first && s.first,
            last && s.last,
            wide && s.wide,
            block && s.blockBubble,
            jumbo && s.jumbo,
            shown && s.waited,
          )}
          data-bubble={block ? bubble.block.kind : "text"}
          data-part={bubble.key}
        >
          {block ? <Block block={bubble.block} answer={props.answer} /> : jumbo ? bubble.text.trim() : <Message text={bubble.text} project={actions?.project} blocks={blocks} />}
          {props.tapback !== undefined ? (
            <span className={s.tapbacks} role="img" aria-label={`You reacted: ${TAPBACK_WORD[props.tapback]}`}>
              {props.tapback}
            </span>
          ) : null}
        </div>
      </ContextMenu>
      {props.receipt !== undefined ? <ReceiptMarkView item={item} latest={props.receipt} /> : null}
      {props.worked !== undefined ? (
        // Beside the bubble's last line, over the room its actions keep: it takes none, so nothing moves as it comes.
        <span className={s.workedSlot}>
          <span className={s.worked}>{props.worked}</span>
        </span>
      ) : null}
      <span className={s.aside}>
        {lead && actions !== undefined ? (
          <>
            <TapbackPicker current={props.tapback} onPick={pick} />
            <Tooltip content="Reply">
              <Button variant="quiet" iconOnly aria-label="Reply" onClick={reply}>
                <Reply />
              </Button>
            </Tooltip>
          </>
        ) : null}
        <span className={s.time}>{shortClock(item.at)}</span>
      </span>
    </div>
  );
}

/** What Not needed sends, under the questions the lead waits on: the lead reads it as your answer. */
export const SKIP = "Not needed: skip that and go on without an answer.";

/** The lead writing, as a line: it enters with the message, and its text takes its place once written, without entering again. */
function TypingLine({ enter }: { enter: Arrival | undefined }) {
  const e = useEnter(enter);
  return (
    <div className={cx(s.line, e.className)} style={e.style}>
      <TypingBubble />
    </div>
  );
}

export function MessageView({ row: r, mineLatest, enter }: { row: Extract<Row, { kind: "message" }>; mineLatest: boolean; enter?: Arrival | undefined }) {
  const i = r.item;
  const actions = useBubbleActions();
  const mine = isMineRow(r);
  const lead = i.author === "lead" && !r.history;
  const body = r.reply?.body;
  // In a lens, of a message about several orders, only the lens's bubbles.
  const only = r.parts;
  const bubbles = useMemo((): readonly Bubble[] => {
    const all: readonly Bubble[] = body !== undefined ? [{ kind: "text", key: "0", text: body }] : bubblesOf(i);
    return only === undefined ? all : all.filter((b) => only.includes(b.key));
  }, [i, body, only]);
  const tags = actions?.tags;
  const marks = useTapbacks(actions === undefined ? "" : projectKey(actions.project));
  const typing = i.state === "streaming";
  const files = i.attachments.length > 0;
  const target = r.reply?.target;
  const quote = useEnter(enter);
  const tail = useEnter(enter, bubbles.length);
  const box = useRef<HTMLDivElement>(null);
  useLooked(box, i.id);
  const shots = useMemo(() => shotsOf(i, bubbles), [i, bubbles]);
  const via = viaOf(i);
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  return (
    <ImageViewerContext.Provider value={shots.length > 0 ? setViewing : undefined}>
      <div
        ref={box}
        className={cx(s.message, r.run && s.messageHead, (r.history || i.author === "agent") && s.quietMessage, mine && s.mine)}
        data-entry="message"
        data-author={i.author}
        data-mine={mine ? "" : undefined}
      >
        {r.tag !== undefined ? (
          <TagLine by={r.head && !mine && i.author !== "lead" ? (r.by ?? authorLabel(i)) : undefined} tag={r.tag} mine={mine} from={i.id} />
        ) : r.head && !mine && i.author !== "lead" ? (
          <div className={s.head} data-head>
            <Text size="xs" tone="quiet">
              {r.by ?? authorLabel(i)}
            </Text>
          </div>
        ) : null}
        {r.reply !== undefined ? (
          <button type="button" className={cx(s.quote, quote.className)} style={quote.style} disabled={target === undefined} onClick={() => target !== undefined && actions?.show(target)} aria-label={`Replying to: ${r.reply.quote}`}>
            <Truncate size="xs" tone="quiet" expand="none" className={s.quoteText}>
              {r.reply.quote}
            </Truncate>
          </button>
        ) : null}
        {typing ? (
          <TypingLine enter={enter} />
        ) : (
          bubbles.map((b, n) => {
            // A message about several orders: a bubble whose order isn't the one before it says which, as a run would.
            const own = n > 0 && tags?.named === true ? partAbout(i, b.key) : undefined;
            const turns = own !== undefined && own.workstreamId !== tags?.lens && own.workstreamId !== partAbout(i, bubbles[n - 1]?.key ?? "")?.workstreamId;
            return [
              turns ? <TagLine key={`tag:${b.key}`} tag={{ order: own }} mine={mine} from={i.id} inner /> : null,
              <BubbleLine
                key={b.key}
                item={i}
                bubble={b}
                first={(r.run && n === 0) || turns}
                last={r.end && n === bubbles.length - 1 && !files}
                lead={lead}
                answer={r.answered?.[b.key]}
                tapback={lead ? marks[bubbleKey(i.id, b.key)] : undefined}
                enter={enter}
                step={n}
                opening={n === 0}
                mine={mine}
                receipt={mine && n === bubbles.length - 1 ? mineLatest : undefined}
                worked={n === bubbles.length - 1 ? r.worked : undefined}
              />,
            ];
          })
        )}
        {lead && !typing && actions?.skips === i.id ? (
          <div className={cx(s.skip, tail.className)} style={tail.style}>
            <Tooltip content={`Sends “${SKIP}”`}>
              <Button variant="link" onClick={() => actions.send(SKIP)}>
                Not needed, skip it
              </Button>
            </Tooltip>
          </div>
        ) : null}
        {files && actions !== undefined ? (
          <div className={cx(s.attachments, tail.className)} style={tail.style}>
            {i.attachments.map((a) => (
              <Attachment key={a.attachmentId} project={actions.project} file={a} />
            ))}
          </div>
        ) : null}
        {via !== undefined ? (
          <div className={cx(s.via, tail.className)} style={tail.style} data-via={i.message?.client}>
            <Send size={12} aria-hidden />
            <Text size="xs" tone="quiet">
              {via}
            </Text>
          </div>
        ) : null}
        {mine && actions !== undefined ? <MessageReceipt project={actions.project} item={i} latest={mineLatest} /> : null}
        {viewing !== undefined && actions !== undefined ? <ImageViewer project={actions.project} shots={shots} at={viewing} onAt={setViewing} /> : null}
      </div>
    </ImageViewerContext.Provider>
  );
}
