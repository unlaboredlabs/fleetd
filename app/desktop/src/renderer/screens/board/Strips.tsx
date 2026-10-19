// The two strips at the bottom of the board. The machine strip: each machine's running agents, load, memory and
// claude usage windows (only what it reports), then the slot board. The train strip: each repo's merge train as
// chips in train order (queued → CI → merged); a chip that changes place slides there, a merged one leaves after
// 10 s. Every move is one transition on a change; nothing runs while the trains stand still.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dot, Tooltip, Truncate, cx, toast } from "../../ui";
import type { MachineLive, PrChip, SlotState, TrainLive } from "./contracts";
import { peekNow, useNow } from "./clock";
import { useData } from "../../src/data/react";
import { EXIT_MS, MERGED_HOLD_MS, type SlotUse, selectStrips } from "./live";
import { useBoardPalette } from "./commands";
import { Track } from "./parts";
import { STAGE_WORD, type Tone, machineParts, slotsText, stageTone } from "./words";
import s from "./Board.module.css";

const TONE: Record<Tone, string | undefined> = {
  quiet: undefined,
  loud: s.loud,
  warning: s.warning,
  danger: s.danger,
  success: s.success,
};

export function MachineStrip({
  machines,
  slots,
  use,
  now,
  onOpen,
}: {
  machines: readonly MachineLive[];
  slots: SlotState | undefined;
  use: SlotUse;
  now: number;
  /** Opens the Machines screen. */
  onOpen?: (() => void) | undefined;
}) {
  if (machines.length === 0 && !slots) return null;
  return (
    <div className={s.strip} data-strip="machines">
      {machines.map((m) => (
        <MachineSeg key={m.machineId} m={m} now={now} onOpen={onOpen} />
      ))}
      {slots ? <span className={s.slots}>{slotsText(slots.cap, use)}</span> : null}
    </div>
  );
}

/**
 * One machine on the strip. Its text is one line that ends in "…" when the window is narrow (the whole of it in the
 * tooltip), so the least important parts at its end (memory, claude usage) are the ones that go.
 */
function MachineSeg({ m, now, onOpen }: { m: MachineLive; now: number; onOpen?: (() => void) | undefined }) {
  const parts = machineParts(m, now);
  const full = `${m.name} ${parts.map(([t]) => t).join(" · ")}`;
  return (
    <Tooltip content={full}>
      <button type="button" className={s.machineSeg} onClick={onOpen} disabled={!onOpen} aria-label={`${full}: open Machines`}>
        <span className={s.machineText} data-text="truncate">
          <span className={s.machineName}>{m.name}</span> <Dot color={m.status === "online" ? "var(--success)" : "var(--warning)"} />{" "}
          {parts.map(([text, tone], i) => (
            <span key={i} className={cx(TONE[tone])}>
              {i > 0 ? " · " : ""}
              {text}
            </span>
          ))}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The chips still on a strip at `now` (hub ms): every chip not merged, and merged ones until their hold ran out.
 * Merges already there when the board first loaded are old news (`mergedAt` has them at 0).
 */
export const visibleChips = (
  chips: readonly PrChip[],
  mergedAt: ReadonlyMap<string, number>,
  now: number,
): { chip: PrChip; leaving: boolean }[] =>
  chips.flatMap((chip) => {
    if (chip.state !== "merged") return [{ chip, leaving: false }];
    const age = now - (mergedAt.get(chip.changeId) ?? 0);
    return age < MERGED_HOLD_MS + EXIT_MS ? [{ chip, leaving: age >= MERGED_HOLD_MS }] : [];
  });

export function TrainStrip({
  trains,
  mergedAt,
  now,
  onOpenPr,
}: {
  trains: readonly TrainLive[];
  mergedAt: ReadonlyMap<string, number>;
  now: number;
  onOpenPr?: (url: string) => void;
}) {
  const rows = trains
    .map((t) => ({ t, chips: visibleChips(t.chips, mergedAt, now) }))
    .filter(({ t, chips }) => chips.length > 0 || t.frozen);
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map(({ t, chips }) => (
        <div key={t.repo} className={s.strip} data-strip="train">
          <span>train</span>
          <Truncate expand="none" mono size="sm" tone="inherit" className={cx(s.repo)}>
            {t.repo}
          </Truncate>
          {t.frozen ? <span className={s.warning}>{t.frozenReason ? `frozen: ${t.frozenReason}` : "frozen"}</span> : null}
          <Chips chips={chips} {...(onOpenPr ? { onOpenPr } : {})} />
          {t.mergedToday > 0 ? <span className={s.mergedToday}>merged today {t.mergedToday}</span> : null}
        </div>
      ))}
    </>
  );
}

/** The chips in train order. A chip whose place changed slides from where it was (FLIP, one transition). */
function Chips({ chips, onOpenPr }: { chips: readonly { chip: PrChip; leaving: boolean }[]; onOpenPr?: (url: string) => void }) {
  const box = useRef<HTMLSpanElement>(null);
  const was = useRef(new Map<string, number>());
  const order = chips.map((c) => c.chip.changeId).join(",");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const now = new Map<string, number>();
    for (const node of el.querySelectorAll<HTMLElement>("[data-chip]")) {
      const id = node.dataset["chip"] ?? "";
      const x = node.offsetLeft;
      now.set(id, x);
      const before = was.current.get(id);
      if (reduce || before === undefined || before === x) continue;
      node.animate([{ transform: `translateX(${before - x}px)` }, { transform: "translateX(0)" }], {
        duration: 240,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
    }
    was.current = now;
  }, [order]);
  // Chips that don't fit are left off whole (never cut at the side), and counted: "+2".
  const [more, setMore] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const slots = [...el.querySelectorAll<HTMLElement>("[data-chip]")];
      for (const n of slots) n.style.display = "";
      // Measured from the rendered boxes, with slack: a font whose metrics differ by a fraction of a pixel (macOS)
      // must not let the last chip through cut.
      const room = (reserve: number) => el.getBoundingClientRect().right - reserve - SLACK;
      const fits = (n: HTMLElement, reserve: number) => n.getBoundingClientRect().right <= room(reserve);
      let hidden = 0;
      if (!slots.every((n) => fits(n, 0))) {
        for (const n of [...slots].reverse()) {
          if (fits(n, MORE_W)) break;
          n.style.display = "none";
          hidden++;
        }
      }
      // Whatever measuring missed, the box itself says: keep dropping from the end while it still overflows.
      for (const n of [...slots].reverse()) {
        if (el.scrollWidth <= el.clientWidth || n.style.display === "none") continue;
        n.style.display = "none";
        hidden++;
      }
      setMore(hidden);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [order]);
  return (
    <>
    <span ref={box} className={s.chips}>
      {chips.map(({ chip, leaving }, i) => (
        <span key={chip.changeId} data-chip={chip.changeId} className={s.chipSlot}>
          {onOpenPr ? (
            <button type="button" className={cx(s.chip, leaving && s.chipLeaving)} onClick={() => onOpenPr(chip.url)}>
              <ChipBody chip={chip} />
            </button>
          ) : (
            <span className={cx(s.chip, s.chipStatic, leaving && s.chipLeaving)}>
              <ChipBody chip={chip} />
            </span>
          )}
          {i + 1 < chips.length ? <span className={s.arrow}>▸</span> : null}
        </span>
      ))}
    </span>
    {more > 0 ? <span className={s.moreChips}>+{more}</span> : null}
    </>
  );
}

/** Room kept for the "+2" after the chips that fit, and slack for sub-pixel font differences. */
const MORE_W = 32;
const SLACK = 2;

function ChipBody({ chip }: { chip: PrChip }) {
  return (
    <>
      <span className={s.prNumber}>#{chip.number}</span>
      <Track state={chip.state} review={0} />
      <span className={TONE[stageTone(chip.state)]}>{STAGE_WORD[chip.state]}</span>
    </>
  );
}

/**
 * When each merged chip was first seen, local ms. Merges already there on the strip's first look are old news (0),
 * so a window opened mid-afternoon doesn't parade the morning's merges. Returns `prev` when nothing is new.
 */
export const noteMerged = (
  prev: ReadonlyMap<string, number> | undefined,
  chips: readonly PrChip[],
  nowMs: number,
): ReadonlyMap<string, number> => {
  const merged = chips.filter((c) => c.state === "merged").map((c) => c.changeId);
  if (prev === undefined) return new Map(merged.map((id) => [id, 0]));
  const fresh = merged.filter((id) => !prev.has(id));
  return fresh.length === 0 ? prev : new Map([...prev, ...fresh.map((id) => [id, nowMs] as const)]);
};

/**
 * The strips along the bottom of the window, under every screen (the frame mounts this): the merge trains, then the
 * machines and the slot board, from the data layer. Until the data layer has them, a skeleton strip.
 */
export function BoardStrips({ onOpenMachines }: { onOpenMachines: () => void }) {
  useBoardPalette();
  const d = useData(selectStrips);
  const [mergedAt, setMergedAt] = useState<ReadonlyMap<string, number> | undefined>(undefined);
  const chips = (d.trains ?? []).flatMap((t) => t.chips);
  const chipKey = chips.map((c) => `${c.changeId}:${c.state}`).join(",");
  const loaded = d.trains !== undefined;
  // First-seen times are this window's memory, not hub data; taken just after the render that showed the chip.
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => setMergedAt((prev) => noteMerged(prev, chips, Date.now())), 0);
    return () => window.clearTimeout(t);
    // chipKey stands for the chips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipKey, loaded]);
  // The strips tick only while a merged chip waits to leave.
  const peek = peekNow();
  const local = useNow([...(mergedAt ?? new Map<string, number>()).values()].some((at) => peek < at + MERGED_HOLD_MS + EXIT_MS));
  const openPr = (url: string) => {
    void window.fleetd.openExternal(url).then((o) => {
      if (!o.ok) toast({ title: "Couldn't open the PR", description: o.message, tone: "danger" });
    });
  };
  const machines = d.machines;
  return (
    <>
      {d.trains !== undefined && mergedAt !== undefined ? (
        <TrainStrip trains={d.trains} mergedAt={mergedAt} now={local} onOpenPr={openPr} />
      ) : null}
      {machines === undefined ? (
        <div className={cx(s.strip, s.skeletonStrip)} aria-hidden data-strip="machines">
          <span className={s.skeleton} />
        </div>
      ) : (
        <MachineStrip machines={machines} slots={d.slots} use={d.use} now={local + d.skewMs} onOpen={onOpenMachines} />
      )}
    </>
  );
}
