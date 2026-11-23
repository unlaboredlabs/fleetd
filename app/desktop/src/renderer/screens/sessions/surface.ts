// What a screen's player hands the frame around it (a flat device frame, or a 3D one's texture): one canvas holding the
// newest picture at the device's own pixel size, the lit panel only, no letterbox and no padding (player.ts).

export interface ScreenSurface {
  /** Holds the newest picture at the device's own pixel size. */
  readonly element: HTMLCanvasElement;
  /** That picture's size in px (it changes when the device turns or an iPhone Duo folds); 0x0 before the first. */
  readonly width: number;
  readonly height: number;
  /** An iPhone Duo's panel the picture is of. */
  readonly panel?: "inner" | "outer";
  /** Called after each new picture lands in `element` (a live frame, a replay's, a seek's); returns off(). */
  onPicture(cb: () => void): () => void;
}
