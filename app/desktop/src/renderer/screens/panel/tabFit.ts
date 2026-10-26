// How the tab bar fits the panel's width: every tab with its label if they fit, else icons only (with their counts,
// the labels in tooltips), else as many icons as fit with the rest under More. The open tab always stays on the bar.
// Pure, on measured widths, so the bar never guesses.

export interface TabWidths {
  /** Each tab with its label, in order. */
  readonly full: readonly number[];
  /** Each tab as its icon and count. */
  readonly icon: readonly number[];
  /** Between two tabs. */
  readonly gap: number;
  /** The More button. */
  readonly more: number;
}

export interface TabFit {
  readonly labels: boolean;
  /** Indexes on the bar, in order. */
  readonly shown: readonly number[];
  /** Indexes under More, in order. */
  readonly more: readonly number[];
}

const sum = (widths: readonly number[], gap: number): number => widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);

export const fitTabs = (w: TabWidths, room: number, active: number): TabFit => {
  const all = w.full.map((_, i) => i);
  if (sum(w.full, w.gap) <= room) return { labels: true, shown: all, more: [] };
  if (sum(w.icon, w.gap) <= room) return { labels: false, shown: all, more: [] };
  // The open tab first, then the rest in order while they fit beside More.
  const order = [active, ...all.filter((i) => i !== active)];
  const shown: number[] = [];
  let used = w.more;
  for (const i of order) {
    const add = (w.icon[i] ?? 0) + w.gap;
    if (shown.length > 0 && used + add > room) break;
    shown.push(i);
    used += add;
  }
  shown.sort((a, b) => a - b);
  return { labels: false, shown, more: all.filter((i) => !shown.includes(i)) };
};
