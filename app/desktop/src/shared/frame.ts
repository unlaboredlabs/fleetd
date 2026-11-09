// The window's frame, as the main process places the macOS traffic lights and the page lays out around them
// (ui/tokens.css --top-bar-height and --traffic-lights-inset say the same in CSS; tokens.test.ts keeps them in step).

/** The floating top row's height: the chat's capsules sit centred in it, and the traffic lights with them. */
export const TOP_BAR = 52;

/** Where hiddenInset puts the traffic lights: inside the inset sidebar's top left corner, centred in the top row. */
export const TRAFFIC_LIGHTS = { x: 20, y: (TOP_BAR - 16) / 2 } as const;
