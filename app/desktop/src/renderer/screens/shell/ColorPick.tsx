// A hub's colour, picked: none, or one of the named colours (shared/hubs.ts), a small swatch each, the chosen one
// ringed by a hairline. Settings › Connections › Hubs and Add a hub use it.
import { HUB_COLORS, type HubColor } from "../../../shared/hubs";
import { Text } from "../../ui";
import { HUB_COLOR } from "./hubColor";
import s from "./shell.module.css";

/** None, or one of the named colours: a small swatch each, the chosen one ringed. */
export function ColorPick({ value, onChange }: { value: HubColor | null; onChange: (color: HubColor | null) => void }) {
  const options: ReadonlyArray<HubColor | null> = [null, ...HUB_COLORS];
  return (
    <div className={s.swatches} role="radiogroup" aria-label="Colour">
      <Text size="xs" tone="quiet">
        Colour
      </Text>
      {options.map((color) => (
        <button
          key={color ?? "none"}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color ?? "No colour"}
          title={color ?? "No colour"}
          className={s.swatch}
          data-none={color === null ? "" : undefined}
          style={color === null ? undefined : { color: HUB_COLOR[color] }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
