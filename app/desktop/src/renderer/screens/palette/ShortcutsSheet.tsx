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

/** "Open project 1…9" reads as one row, not nine. */
const rowsFor = (list: readonly Shortcut[], platform: Platform): { title: string; keys: string }[] => {
  const out: { title: string; keys: string }[] = [];
  const jumps = list.filter((sc) => /^Mod\+[1-9]$/u.test(sc.keys));
  for (const sc of list) {
    if (!jumps.includes(sc)) out.push({ title: sc.title.replace(/…$/u, ""), keys: displayKeys(sc.keys, platform) });
    else if (sc === jumps[0]) out.push({ title: sc.title.replace(/ 1\b/u, " 1–9"), keys: `${displayKeys(sc.keys, platform).slice(0, -1)}1–9` });
  }
  return out;
};

export function ShortcutsSheet() {
  const platform = window.fleetd.platform;
  const returnFocus = useReturnFocus();
  const local = Map.groupBy(LOCAL_KEYS, (k) => k.where);
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
            {SECTIONS.map((section) => (
              <section key={section} className={s.sheetSection}>
                <h3>{section}</h3>
                <dl className={s.sheetRows}>
                  {rowsFor(ALL.filter((sc) => sc.section === section), platform).map((row) => (
                    <div key={row.title} className={s.sheetRow}>
                      <dt>
                        <Text>{row.title}</Text>
                      </dt>
                      <dd>
                        <Kbd>{row.keys}</Kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            {[...local].map(([where, rows]) => (
              <section key={where} className={s.sheetSection}>
                <h3>{where}</h3>
                <dl className={s.sheetRows}>
                  {rows.map((row) => (
                    <div key={row.title} className={s.sheetRow}>
                      <dt>
                        <Text>{row.title}</Text>
                      </dt>
                      <dd>
                        {row.keys.map((k) => (
                          <Kbd key={k}>{k.includes("+") ? displayKeys(k, platform) : k}</Kbd>
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
