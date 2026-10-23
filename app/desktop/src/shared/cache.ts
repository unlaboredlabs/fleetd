// The disk cache's envelope, which main checks before keeping or handing back the renderer's text (the renderer's
// src/data/cache.ts has the whole shape).
export const HUB_CACHE_VERSION = 1;
/** A cache bigger than this is refused; the renderer drops its least active chats to fit. */
export const HUB_CACHE_MAX_BYTES = 2 * 1024 * 1024;
