// node:fs and node:path in the web preview (web/vite.config.ts): main/hub/fixture.ts imports them for loadFixture,
// which the page never calls. Anything that does is a bug in the preview, so it says so.
const unavailable = (name: string) => (): never => {
  throw new Error(`${name} isn't available in the web preview`);
};

export const readFileSync = unavailable("readFileSync");
export const isAbsolute = unavailable("isAbsolute");
export const join = unavailable("join");
