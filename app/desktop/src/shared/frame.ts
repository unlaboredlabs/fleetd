// The window's frame, as the main process places the macOS traffic lights and the page lays out around them
// (ui/tokens.css --top-bar-height and --traffic-lights-inset say the same in CSS; tokens.test.ts keeps them in step).

/** The floating top row's height: the chat's pill sits centred in it, and the traffic lights and New with it. */
export const TOP_BAR = 52;

/** Where hiddenInset puts the traffic lights: in the flush sidebar's first row, on one centre line with New and the pill. */
export const TRAFFIC_LIGHTS = { x: 20, y: (TOP_BAR - 16) / 2 } as const;
