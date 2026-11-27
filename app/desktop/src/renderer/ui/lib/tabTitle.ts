// The browser tab's title on the web: where you are, then fleetd ("storefront · fleetd", "Settings · fleetd"), after
// how many things wait on you ("(1) …"), so two tabs and the Back menu's entries tell themselves apart. Screens say
// their place (FrameTitle, the Settings sheet over them); the newest still shown wins. Only the web turns it on: the
// desktop's window keeps its own title.

const APP = "fleetd";

let on = false;
let count = 0;
const places: string[] = [];

const write = () => {
  if (!on || typeof document === "undefined") return;
  const place = places.at(-1);
  const base = place === undefined || place === "" ? APP : `${place} · ${APP}`;
  document.title = count > 0 ? `(${String(count)}) ${base}` : base;
};

/** The web's: the tab's title follows the screens from now on. */
export const followTabTitle = (): void => {
  on = true;
  write();
};

/** How many things wait on you, in front of the title. */
export const tabCount = (n: number): void => {
  count = n;
  write();
};

/** Says `place` while shown: the returned function takes it back (an effect's cleanup). */
export const tabPlace = (place: string): (() => void) => {
  places.push(place);
  write();
  return () => {
    const i = places.lastIndexOf(place);
    if (i !== -1) places.splice(i, 1);
    write();
  };
};
