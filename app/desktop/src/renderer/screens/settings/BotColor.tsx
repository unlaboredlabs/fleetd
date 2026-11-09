// Settings › Projects › Color: the color of the project's bot (shared/bot.ts BOT_PAINT), a row of swatches, each the
// bot's body in the app's theme, the picked one ringed. A pick shows at once and is saved with project_settings_set
// (avatarColor); the hub's project.settings event brings it to every app that shows the project. A picture, when the
// project has one, still shows over the bot.
import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { BOT_COLORS, BOT_PAINT, botColorLabel, type BotColorName } from "../../../shared/bot";
import type { ProjectSummary } from "../../../shared/contracts";
import { errorText, useHubCall } from "./hub";
import { SettingsRow } from "./parts";
import c from "./BotColor.module.css";

type Colored = Pick<ProjectSummary, "machineId" | "projectId" | "title" | "avatar" | "avatarColor">;

/** The project's color as a swatch knows it: slate for none, or for one this app doesn't know yet. */
const known = (color: string | undefined): BotColorName => (BOT_COLORS as readonly string[]).includes(color ?? "") ? (color as BotColorName) : "slate";

export function BotColorSetting({ project }: { project: Colored }) {
  const hubCall = useHubCall();
  const saved = known(project.avatarColor);
  // The pick in flight, with the color it was picked over: shown until the hub's summary names another (this one, or
  // another device's).
  const [picked, setPicked] = useState<{ color: BotColorName; over: BotColorName } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = picked !== null && picked.over === saved ? picked.color : saved;

  const pick = (color: BotColorName) => {
    if (color === shown) return;
    const mine = { color, over: saved };
    setPicked(mine);
    setProblem(null);
    hubCall("project_settings_set", { machineId: project.machineId, projectId: project.projectId, avatarColor: color }).catch((e: unknown) => {
      setPicked((p) => (p === mine ? null : p));
      setProblem(errorText(e));
    });
  };
  // A radio group's keys: the arrows move the pick, Home and End to either end.
  const key = (e: KeyboardEvent, i: number) => {
    const n = BOT_COLORS.length;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const j = (to + n) % n;
    swatches.current[j]?.focus();
    pick(BOT_COLORS[j] ?? "slate");
  };

  return (
    <SettingsRow
      reveal="projects.color"
      title="Color"
      titleId="bot-color-title"
      line={
        problem !== null ? (
          <span role="alert">{problem}</span>
        ) : project.avatar !== undefined ? (
          "Its bot's color, which shows when you remove its image."
        ) : (
          "Its bot's color, wherever it shows, on every device."
        )
      }
      lineTone={problem === null ? "quiet" : "danger"}
      control={
        <div className={c.swatches} role="radiogroup" aria-labelledby="bot-color-title">
          {BOT_COLORS.map((color, i) => (
            <button
              key={color}
              ref={(el) => {
                swatches.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={color === shown}
              aria-label={botColorLabel(color)}
              title={botColorLabel(color)}
              tabIndex={color === shown ? 0 : -1}
              className={c.swatch}
              data-color={color}
              style={{ "--light": BOT_PAINT[color].light.body, "--dark": BOT_PAINT[color].dark.body } as CSSProperties}
              onClick={() => pick(color)}
              onKeyDown={(e) => key(e, i)}
            />
          ))}
        </div>
      }
    />
  );
}
