// The circle a picture is moved and scaled in before it becomes a chat's picture (the phone's screens/manage/Photo.tsx,
// the desktop's screens/settings/Picture.tsx), as iOS's own Move and Scale: at zoom 1 its shorter side fills the
// circle, it zooms in up to MAX_ZOOM, and it never moves so far that the circle shows past its edge. Then the square
// the circle covers, in the picture's own pixels, for the hub to keep (project_avatar_set's crop). Worklets, so the
// phone's gestures run them on the UI thread; pure, so unit-tested.

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** How far in a person can zoom. */
export const MAX_ZOOM = 5;

/** Points per picture pixel at zoom 1: the shorter side spans the circle. */
export const baseScale = (picture: Size, circle: number): number => {
  "worklet";
  return circle / Math.max(1, Math.min(picture.width, picture.height));
};

/** The zoom kept inside 1..MAX_ZOOM. */
export const clampZoom = (zoom: number): number => {
  "worklet";
  return Math.min(MAX_ZOOM, Math.max(1, zoom));
};

/** The farthest the picture's centre moves from the circle's, each way, at `zoom`: the circle stays covered. */
export const reach = (picture: Size, circle: number, zoom: number): { x: number; y: number } => {
  "worklet";
  const s = baseScale(picture, circle) * zoom;
  return { x: Math.max(0, (picture.width * s - circle) / 2), y: Math.max(0, (picture.height * s - circle) / 2) };
};

/** An offset kept inside `reach`. */
export const clampPan = (picture: Size, circle: number, zoom: number, x: number, y: number): { x: number; y: number } => {
  "worklet";
  const r = reach(picture, circle, zoom);
  // + 0: no -0 where it can't move.
  return { x: Math.min(r.x, Math.max(-r.x, x)) + 0, y: Math.min(r.y, Math.max(-r.y, y)) + 0 };
};

/**
 * The offset that keeps the point under the fingers (`focus`, from the circle's centre) where it is while the zoom
 * goes from `from` to `to`.
 */
export const zoomAbout = (offset: number, focus: number, from: number, to: number): number => {
  "worklet";
  return focus - (focus - offset) * (to / from);
};

/** The square the circle covers, in the picture's pixels: its top-left corner and side. */
export const cropOf = (picture: Size, circle: number, zoom: number, x: number, y: number): { x: number; y: number; size: number } => {
  const s = baseScale(picture, circle) * zoom;
  const pan = clampPan(picture, circle, zoom, x, y);
  const size = Math.max(1, Math.min(Math.round(circle / s), Math.min(picture.width, picture.height)));
  const left = (picture.width * s) / 2 - pan.x - circle / 2;
  const top = (picture.height * s) / 2 - pan.y - circle / 2;
  const fit = (n: number, side: number) => Math.min(Math.max(0, Math.round(n / s)), Math.max(0, side - size));
  return { x: fit(left, picture.width), y: fit(top, picture.height), size };
};
