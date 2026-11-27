// Every keyboard shortcut, read from the one shortcut map, so the sheet can't drift from the keys or the menu.

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { LOCAL_KEYS, SHORTCUTS, displayKeys, type Platform, type Shortcut } from "../../../shared/shortcuts";
import { Button, Kbd, Text } from "../../ui";
import { useReturnFocus } from "./focus";
import { closeOverlay } from "./state";
import s from "./Palette.module.css";

const ALL: readonly Shortcut[] = Object.values(SHORTCUTS);
/** In the table's own order, so the sheet follows the table. */
const SECTIONS = [...new Set(ALL.map((sc) => sc.section))];

interface Row {
  readonly title: string;
  readonly keys: readonly string[];
}

/** "Open project 1…9" reads as one row, not nine. */
const rowsFor = (list: readonly Shortcut[], platform: Platform): Row[] => {
  const out: Row[] = [];
  const jumps = list.filter((sc) => /^Mod\+[1-9]$/u.test(sc.keys));
  for (const sc of list) {
    if (!jumps.includes(sc)) out.push({ title: sc.title.replace(/…$/u, ""), keys: [displayKeys(sc.keys, platform)] });
    else if (sc === jumps[0]) out.push({ title: sc.title.replace(/ 1\b/u, " 1–9"), keys: [`${displayKeys(sc.keys, platform).slice(0, -1)}1–9`] });
  }
  return out;
};

/** One list of sections: the menus' own, each with the keys its part handles itself (LOCAL_KEYS), then those parts'
 * own sections, so no name shows twice. */
export const sections = (platform: Platform): { readonly name: string; readonly rows: readonly Row[] }[] => {
  const local = Map.groupBy(LOCAL_KEYS, (k) => k.where);
  const its = (name: string): Row[] => (local.get(name) ?? []).map((k) => ({ title: k.title, keys: k.keys.map((key) => (key.includes("+") ? displayKeys(key, platform) : key)) }));
  return [
    ...SECTIONS.map((name) => ({ name, rows: [...rowsFor(ALL.filter((sc) => sc.section === name), platform), ...its(name)] })),
    ...[...local.keys()].filter((name) => !(SECTIONS as readonly string[]).includes(name)).map((name) => ({ name, rows: its(name) })),
  ];
};

export function ShortcutsSheet() {
  const platform = window.fleetd.platform;
  const returnFocus = useReturnFocus();
  return (
    <D.Root open onOpenChange={(open) => !open && closeOverlay()}>
      <D.Portal>
        <D.Overlay className={s.backdrop} />
        <D.Content className={s.sheet} data-screen="shortcuts" aria-describedby={undefined} onCloseAutoFocus={returnFocus}>
          <div className={s.sheetHead}>
            <D.Title className={s.sheetTitle}>Keyboard shortcuts</D.Title>
            <D.Close asChild>
              <Button variant="quiet" iconOnly aria-label="Close">
                <X />
              </Button>
            </D.Close>
          </div>
          <div className={s.sheetBody}>
            {sections(platform).map(({ name, rows }) => (
              <section key={name} className={s.sheetSection}>
                <h3>{name}</h3>
                <dl className={s.sheetRows}>
                  {rows.map((row) => (
                    <div key={row.title} className={s.sheetRow}>
                      <dt>
                        <Text>{row.title}</Text>
                      </dt>
                      <dd>
                        {row.keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
