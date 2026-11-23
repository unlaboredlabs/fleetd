// What the window holds that a reload would lose and no field shows, such as a chat draft's files (only its words are
// kept): the web page switches to a new build by itself only while none holds anything (src/web/build.ts).
const holds = new Set<() => boolean>();

/** `holding` says, when asked, whether its part of the window holds anything now. */
export const holdOnReload = (holding: () => boolean): void => void holds.add(holding);
/** Whether any part of the window holds what a reload would lose. */
export const heldOnReload = (): boolean => [...holds].some((holding) => holding());
