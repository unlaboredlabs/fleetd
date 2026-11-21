// Settings › Projects › Look: the bot's body and color (shared/bot.ts BOT_BODIES and BOT_PAINT), one compact picker:
// a row of the five shapes, each a small bot in its color, over one row of the palette's flat dots, each the bot's body
// in the app's theme, the picked one of each ringed. An earlier color name (lilac) shows as the color it became
// (purple), a shape this app doesn't know as Pebble. A pick shows at once and is saved with project_settings_set
// (avatarShape, avatarColor); the hub's project.settings event brings it to every app that shows the bot. A picture,
// when the bot has one, still shows over it.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { BOT_COLORS, BOT_PAINT, BOT_SHAPES, botColorLabel, botShapeLabel, colorOf, shapeOf, type BotColorName, type BotShapeName } from "../../../shared/bot";
import type { ProjectSummary } from "../../../shared/contracts";
import { Bot } from "../../ui/primitives/Bot";
import { errorText, useHubCall } from "./hub";
import { SettingsRow } from "./parts";
import c from "./BotLook.module.css";

type Looked = Pick<ProjectSummary, "machineId" | "projectId" | "title" | "avatar" | "avatarColor" | "avatarShape">;

/** A pick in flight, with the value it was picked over: shown until the hub's summary names another (this one, or
 * another device's). */
type InFlight<T> = { readonly value: T; readonly over: T } | null;

/** One radio group of the picker: the arrows move the pick, Home and End to either end. */
function Radios<T extends string>({ label, values, shown, name, onPick, children }: { label: string; values: readonly T[]; shown: T; name: (v: T) => string; onPick: (v: T) => void; children: (v: T) => ReactNode }) {
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const key = (e: KeyboardEvent, i: number) => {
    const n = values.length;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const j = (to + n) % n;
    radios.current[j]?.focus();
    const v = values[j];
    if (v !== undefined) onPick(v);
  };
  return (
    <div className={c.radios} role="radiogroup" aria-label={label}>
      {values.map((v, i) => (
        <button
          key={v}
          ref={(el) => {
            radios.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={v === shown}
          aria-label={name(v)}
          title={name(v)}
          tabIndex={v === shown ? 0 : -1}
          onClick={() => onPick(v)}
          onKeyDown={(e) => key(e, i)}
          {...{ [`data-${label.toLowerCase()}`]: v }}
          className={label === "Shape" ? c.shape : c.swatch}
          style={label === "Color" ? ({ "--light": BOT_PAINT[v as BotColorName].light.body, "--dark": BOT_PAINT[v as BotColorName].dark.body } as CSSProperties) : undefined}
        >
          {children(v)}
        </button>
      ))}
    </div>
  );
}

export function BotLookSetting({ project }: { project: Looked }) {
  const hubCall = useHubCall();
  const savedColor = colorOf(project.avatarColor);
  const savedShape = shapeOf(project.avatarShape);
  const [color, setColor] = useState<InFlight<BotColorName>>(null);
  const [shape, setShape] = useState<InFlight<BotShapeName>>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Once the hub names another value than the one a pick was made over, the pick is done with: a later change back
  // must not bring it up again.
  if (color !== null && color.over !== savedColor) setColor(null);
  if (shape !== null && shape.over !== savedShape) setShape(null);
  const shownColor = color !== null && color.over === savedColor ? color.value : savedColor;
  const shownShape = shape !== null && shape.over === savedShape ? shape.value : savedShape;
  const ref = { machineId: project.machineId, projectId: project.projectId };

  const pickColor = (value: BotColorName) => {
    if (value === shownColor) return;
    const mine = { value, over: savedColor };
    setColor(mine);
    setProblem(null);
    hubCall("project_settings_set", { ...ref, avatarColor: value }).catch((e: unknown) => {
      setColor((p) => (p === mine ? null : p));
      setProblem(errorText(e));
    });
  };
  const pickShape = (value: BotShapeName) => {
    if (value === shownShape) return;
    const mine = { value, over: savedShape };
    setShape(mine);
    setProblem(null);
    hubCall("project_settings_set", { ...ref, avatarShape: value }).catch((e: unknown) => {
      setShape((p) => (p === mine ? null : p));
      setProblem(errorText(e));
    });
  };

  return (
    <SettingsRow
      reveal="projects.look"
      title="Look"
      titleId="bot-look-title"
      hint={project.avatar !== undefined ? "Its bot's shape and color, which show when you remove its image." : "Its bot's shape and color, wherever it shows, on every device."}
      line={problem !== null ? <span role="alert">{problem}</span> : null}
      lineTone={problem === null ? "quiet" : "danger"}
      control={
        <div className={c.picker} aria-labelledby="bot-look-title" role="group">
          <Radios label="Shape" values={BOT_SHAPES} shown={shownShape} name={botShapeLabel} onPick={pickShape}>
            {(s) => <Bot state="idle" size={20} color={shownColor} shape={s} />}
          </Radios>
          <Radios label="Color" values={BOT_COLORS} shown={shownColor} name={botColorLabel} onPick={pickColor}>
            {() => null}
          </Radios>
        </div>
      }
    />
  );
}
