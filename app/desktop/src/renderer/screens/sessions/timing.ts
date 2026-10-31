// A screen's way to its first frame, as performance marks (DevTools' Performance panel shows them; a test reads them
// with performance.getEntriesByType("mark")): `screen.click` (New screen's Open), `screen.opened` (the hub answered
// screen_open), `screen.view` (the live view is up), `screen.watch` (it asked for the session's frames),
// `screen.frame` (the first frame came) and `screen.painted` (it is on screen). Each carries its session, when known,
// as its detail; each but the click is marked once per session and view.

export type ScreenStep = "click" | "opened" | "view" | "watch" | "frame" | "painted";

export const screenMark = (step: ScreenStep, sessionId?: string): void => {
  performance.mark(`screen.${step}`, sessionId === undefined ? undefined : { detail: { sessionId } });
};
