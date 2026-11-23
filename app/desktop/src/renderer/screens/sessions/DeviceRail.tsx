// A phone screen's toolbar (W859, after D652's strip): slim capsules of quiet icons beside the device, each named in its
// tooltip. While the screen is yours: home and rotate; light or dark, text size and a screenshot, the rest (rotate
// right, back, lock, shake, location) behind More; an iPhone Duo's postures (closed, book, open, laptop). Always: 3D or
// flat, and Face front once a drag turned it. Only the controls its machine says work there show (strip.ts railOf);
// each press is one screen_control call, and the device turns or folds with its simulator. A screenshot is copied, with
// Save.
import { Box, Camera, Ellipsis, Focus, House, Lock, MapPin, Moon, RotateCcw, RotateCw, Smartphone, Sun, Type, Undo2, Vibrate } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Button,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  toast,
} from "../../ui";
import { useDataLayer } from "../../src/data/react";
import type { BrowserSessionsOutput } from "../../../shared/contracts";
import type { StageView } from "./DeviceStage";
import type { PhoneDevice } from "./model";
import { appearanceWord, CONTROL_WORD, latLon, otherAppearance, PLACES, POSTURE, railOf, shotName, TEXT_SIZES, textSizeWord, type RailControl } from "./strip";
import s from "./sessions.module.css";

const ICON: Readonly<Partial<Record<RailControl, ReactNode>>> = {
  rotate_left: <RotateCcw aria-hidden />,
  rotate_right: <RotateCw aria-hidden />,
  home: <House aria-hidden />,
  back: <Undo2 aria-hidden />,
  lock: <Lock aria-hidden />,
  shake: <Vibrate aria-hidden />,
  location: <MapPin aria-hidden />,
  screenshot: <Camera aria-hidden />,
  text_size: <Type aria-hidden />,
};

export function DeviceRail({ sessionId, device, name, view }: { sessionId: string; device: PhoneDevice | undefined; name: string; view: StageView }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState<RailControl | null>(null);
  const [placing, setPlacing] = useState(false);
  const rail = device === undefined ? undefined : railOf(device.controls, device.folds);

  const press = async (control: RailControl, value?: string) => {
    setBusy(control);
    const out = await layer.call("screen_control", { sessionId, control, ...(value === undefined ? {} : { value }) });
    setBusy(null);
    if (!out.ok) {
      toast({ title: `${CONTROL_WORD[control]} didn’t work`, description: out.error.message, tone: "danger", key: `control:${sessionId}` });
      return;
    }
    // Its new state shows from the answer at once, before the list reads it again.
    if (out.output.session !== undefined) {
      const session = out.output.session;
      layer.queryClient.setQueriesData<BrowserSessionsOutput>({ queryKey: ["call", "browser_sessions"] }, (old) =>
        old === undefined ? old : { ...old, sessions: old.sessions.map((x) => (x.sessionId === session.sessionId ? session : x)) },
      );
    }
    const shot = out.output.screenshot;
    if (control === "screenshot" && shot !== undefined) void copyShot(shot, name);
  };

  const button = (key: string, word: string, icon: ReactNode, onClick: () => void, opts: { pressed?: boolean; disabled?: boolean } = {}) => (
    <Tooltip key={key} content={word} side="left">
      <Button
        variant="quiet"
        size="md"
        iconOnly
        aria-label={word}
        aria-pressed={opts.pressed}
        className={s.railButton}
        disabled={opts.disabled === true}
        onClick={onClick}
      >
        {icon}
      </Button>
    </Tooltip>
  );
  const control = (c: RailControl): ReactNode => {
    switch (c) {
      case "appearance":
        return button(c, appearanceWord(device?.appearance), device?.appearance === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />, () => void press(c, otherAppearance(device?.appearance)), {
          disabled: busy === c,
        });
      case "text_size":
        return (
          <Menu key={c}>
            <Tooltip content={`Text size: ${textSizeWord(device?.textSize).toLowerCase()}`} side="left">
              <MenuTrigger asChild>
                <Button variant="quiet" size="md" iconOnly aria-label="Text size" className={s.railButton} disabled={busy === c}>
                  {ICON.text_size}
                </Button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent side="left" align="start">
              <MenuRadioGroup aria-label="Text size" value={device?.textSize ?? ""} onValueChange={(v) => void press(c, v)}>
                {TEXT_SIZES.map((t) => (
                  <MenuRadioItem key={t.value} value={t.value}>
                    {t.word}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        );
      default:
        return button(c, c === "rotate_left" ? "Rotate" : CONTROL_WORD[c], ICON[c], () => void press(c), { disabled: busy === c });
    }
  };

  return (
    <div className={s.rail} role="toolbar" aria-label="Device" aria-orientation="vertical">
      {rail === undefined || rail.buttons.length === 0 ? null : <div className={s.railGroup}>{rail.buttons.map(control)}</div>}
      {rail === undefined || rail.look.length + rail.more.length === 0 ? null : (
        <div className={s.railGroup}>
          {rail.look.map(control)}
          {rail.more.length === 0 ? null : (
            <Menu>
              <Tooltip content="More" side="left">
                <MenuTrigger asChild>
                  <Button variant="quiet" size="md" iconOnly aria-label="More" className={s.railButton}>
                    <Ellipsis aria-hidden />
                  </Button>
                </MenuTrigger>
              </Tooltip>
              <MenuContent side="left" align="start">
                {rail.more.map((c) =>
                  c === "location" ? (
                    <MenuItem key={c} icon={ICON[c]} onSelect={() => setPlacing(true)}>
                      Location…
                    </MenuItem>
                  ) : (
                    <MenuItem key={c} icon={ICON[c]} disabled={busy === c} onSelect={() => void press(c)}>
                      {CONTROL_WORD[c]}
                    </MenuItem>
                  ),
                )}
              </MenuContent>
            </Menu>
          )}
          {rail.more.includes("location") ? <Location open={placing} onOpenChange={setPlacing} busy={busy === "location"} onSet={(at) => void press("location", at)} /> : null}
        </div>
      )}
      <div className={s.railGroup}>
        {button("3d", view.mode === "3d" ? "Show it flat" : view.flatOnly ? "3D needs WebGL, which this computer doesn’t have" : "Show it in 3D", view.mode === "3d" ? <Smartphone aria-hidden /> : <Box aria-hidden />, () => view.setMode(view.mode === "3d" ? "flat" : "3d"), {
          disabled: view.mode === "flat" && view.flatOnly,
        })}
        {view.face === undefined ? null : button("face", "Face front", <Focus aria-hidden />, view.face)}
      </div>
      {rail === undefined || rail.postures.length === 0 ? null : (
        <div className={s.railGroup} role="group" aria-label="Posture">
          {rail.postures.map((p) =>
            button(p, POSTURE[p] ?? p, <PostureGlyph posture={p} />, () => void press("fold", p), { pressed: device?.fold === p, disabled: busy === "fold" }),
          )}
        </div>
      )}
    </div>
  );
}

/** A Duo's posture as a line drawing: shut, a book, open flat, a laptop. Drawn here, 24 × 24 as lucide's. */
function PostureGlyph({ posture }: { posture: string }) {
  const paths: Readonly<Record<string, ReactNode>> = {
    closed: <rect x="7" y="3" width="10" height="18" rx="2.5" />,
    "half-open": (
      <>
        <path d="M12 6.5 4 3.5v14l8 3z" />
        <path d="M12 6.5l8-3v14l-8 3z" />
      </>
    ),
    open: (
      <>
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="M12 5v14" />
      </>
    ),
    laptop: (
      <>
        <path d="M6 4h12a1.5 1.5 0 0 1 1.5 1.5V14h-15V5.5A1.5 1.5 0 0 1 6 4z" />
        <path d="M4.5 14 2 19.5h20L19.5 14" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[posture] ?? paths.closed}
    </svg>
  );
}

/** Location: a place in one press, or one typed as "lat, lon"; opened from More. */
function Location({ open, onOpenChange, busy, onSet }: { open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; onSet: (at: string) => void }) {
  const [typed, setTyped] = useState("");
  const at = latLon(typed);
  const set = (value: string) => {
    onOpenChange(false);
    onSet(value);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <span className={s.railAnchor} aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className={s.places}>
        {PLACES.map((p) => (
          <Button key={p.name} variant="quiet" size="sm" className={s.place} disabled={busy} onClick={() => set(p.at)}>
            {p.name}
          </Button>
        ))}
        <form
          className={s.placeTyped}
          onSubmit={(e) => {
            e.preventDefault();
            if (at !== null) set(at);
          }}
        >
          <Input aria-label="Latitude, longitude" placeholder="Lat, lon" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <Button type="submit" variant="secondary" size="sm" disabled={at === null}>
            Set
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** A screenshot onto the clipboard, with Save to keep it as a file. */
async function copyShot(shot: { readonly mime: string; readonly dataB64: string }, name: string): Promise<void> {
  const bytes = Uint8Array.from(atob(shot.dataB64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: shot.mime });
  const file = shotName(name, new Date());
  const save = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const copied = await navigator.clipboard.write([new ClipboardItem({ [shot.mime]: blob })]).then(
    () => true,
    () => false,
  );
  if (copied) toast({ title: "Screenshot copied", action: { label: "Save", onClick: save }, key: "screenshot" });
  else save();
}
