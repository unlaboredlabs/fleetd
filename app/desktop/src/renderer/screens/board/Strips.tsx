// The two strips at the bottom of the board. The machine strip: each machine's running agents, load, memory and
// claude usage windows (only what it reports), then the slot board. The train strip: each repo's merge train as
// chips in train order (queued → CI → merged); a chip that changes place slides there, a merged one leaves after
// 10 s. Every move is one transition on a change; nothing runs while the trains stand still.
import { useLayoutEffect, useRef } from "react";
import { Dot, Truncate, cx, toast } from "../../ui";
import type { MachineLive, PrChip, SlotState, TrainLive } from "./contracts";
import { peekNow, useNow } from "./clock";
import { EXIT_MS, MERGED_HOLD_MS, type SlotUse, hubNow, machines, needsClock, slotUse, trains } from "./live";
import { useBoardPalette } from "./commands";
import { useBoardState } from "./source";
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
        <button type="button" key={m.machineId} className={s.machineSeg} onClick={onOpen} disabled={!onOpen} aria-label={`${m.name}: open Machines`}>
          <span className={s.machineName}>{m.name}</span>
          <Dot color={m.status === "online" ? "var(--success)" : "var(--warning)"} label={m.status} />
          {machineParts(m, now).map(([text, tone], i) => (
            <span key={i} className={cx(TONE[tone])}>
              {i > 0 ? "· " : ""}
              {text}
            </span>
          ))}
        </button>
      ))}
      {slots ? <span className={s.slots}>{slotsText(slots.cap, use)}</span> : null}
    </div>
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
  return (
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
  );
}

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
 * The strips along the bottom of the window, under every screen (the frame mounts this): the merge trains, then
 * the machines and the slot board, from the board's store.
 */
export function BoardStrips({ onOpenMachines }: { onOpenMachines: () => void }) {
  useBoardPalette();
  const { live } = useBoardState();
  const now = hubNow(live, useNow(needsClock(live, hubNow(live, peekNow()))));
  const openPr = (url: string) => {
    void window.fleetd.openExternal(url).then((o) => {
      if (!o.ok) toast({ title: "Couldn't open the PR", description: o.message, tone: "danger" });
    });
  };
  return (
    <>
      <TrainStrip trains={trains(live)} mergedAt={live.mergedAt} now={now} onOpenPr={openPr} />
      <MachineStrip machines={machines(live)} slots={live.slots} use={slotUse(live)} now={now} onOpen={onOpenMachines} />
    </>
  );
}
