// A phone screen's control strip (D652): a slim column of quiet icons beside the phone, each named in its tooltip, only
// the controls its machine says work there (strip.ts): turn it, fold it (the iPhone Duo), home, back (Android), lock,
// shake, light or dark, its location, and a screenshot. Shown while the screen is yours; each press is one
// screen_control call, and the phone in the view turns or folds with its device (turn.ts). A screenshot is copied, with Save.
import { Camera, FoldHorizontal, House, Lock, MapPin, Moon, RotateCcw, RotateCw, Sun, Undo2, Vibrate } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Input, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip, toast } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import type { BrowserSessionsOutput } from "../../../shared/contracts";
import type { PhoneDevice } from "./model";
import { appearanceWord, CONTROL_WORD, foldWord, latLon, otherAppearance, PLACES, shotName, stripOf, type StripControl } from "./strip";
import s from "./sessions.module.css";

const ICON: Readonly<Record<Exclude<StripControl, "appearance">, ReactNode>> = {
  rotate_left: <RotateCcw aria-hidden />,
  rotate_right: <RotateCw aria-hidden />,
  fold: <FoldHorizontal aria-hidden />,
  home: <House aria-hidden />,
  back: <Undo2 aria-hidden />,
  lock: <Lock aria-hidden />,
  shake: <Vibrate aria-hidden />,
  location: <MapPin aria-hidden />,
  screenshot: <Camera aria-hidden />,
};

export function ControlStrip({ sessionId, device, name }: { sessionId: string; device: PhoneDevice; name: string }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState<StripControl | null>(null);
  const groups = stripOf(device.controls, device.folds);
  if (groups.length === 0) return null;

  const press = async (control: StripControl, value?: string) => {
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

  const button = (control: StripControl, word: string, icon: ReactNode, onClick?: () => void) => (
    <Tooltip key={control} content={word} side="right">
      <Button variant="quiet" size="sm" iconOnly aria-label={word} className={s.stripButton} disabled={busy === control} onClick={onClick}>
        {icon}
      </Button>
    </Tooltip>
  );

  const control = (c: StripControl): ReactNode => {
    switch (c) {
      case "appearance": {
        const word = appearanceWord(device.appearance);
        return button(c, word, device.appearance === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />, () => void press(c, otherAppearance(device.appearance)));
      }
      case "fold":
        return (
          <Menu key={c}>
            <Tooltip content={device.fold === undefined ? "Fold" : `Fold: ${foldWord(device.fold).toLowerCase()}`} side="right">
              <MenuTrigger asChild>
                <Button variant="quiet" size="sm" iconOnly aria-label="Fold" className={s.stripButton} disabled={busy === c}>
                  {ICON.fold}
                </Button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent side="right" align="start">
              <MenuRadioGroup aria-label="Fold" value={device.fold ?? ""} onValueChange={(v) => void press(c, v)}>
                {(device.folds ?? []).map((f) => (
                  <MenuRadioItem key={f} value={f}>
                    {foldWord(f)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        );
      case "location":
        return <Location key={c} busy={busy === c} onSet={(at) => void press(c, at)} />;
      default:
        return button(c, CONTROL_WORD[c], ICON[c], () => void press(c));
    }
  };

  return (
    <div className={s.strip} role="toolbar" aria-label="Device" aria-orientation="vertical">
      {groups.map((g) => (
        <div key={g.join()} className={s.stripGroup}>
          {g.map(control)}
        </div>
      ))}
    </div>
  );
}

/** Location: a place in one press, or one typed as "lat, lon". */
function Location({ busy, onSet }: { busy: boolean; onSet: (at: string) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const at = latLon(typed);
  const set = (value: string) => {
    setOpen(false);
    onSet(value);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Location" side="right">
        <PopoverTrigger asChild>
          <Button variant="quiet" size="sm" iconOnly aria-label="Location" className={s.stripButton} disabled={busy}>
            <MapPin aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="right" align="start" className={s.places}>
        {PLACES.map((p) => (
          <Button key={p.name} variant="quiet" size="sm" className={s.place} onClick={() => set(p.at)}>
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
