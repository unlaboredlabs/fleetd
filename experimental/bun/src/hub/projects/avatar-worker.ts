// The avatar worker: renders one picture (avatar-render.ts) off the hub's thread, then is let go.
import type { AvatarCrop } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { render } from "./avatar-render.ts";

export type RenderRequest = { bytes: Uint8Array; crop?: AvatarCrop };
export type RenderReply = { jpeg: Uint8Array } | { message: string; fix?: string; invalid: boolean };

declare const self: Worker;

self.onmessage = async (event: MessageEvent<RenderRequest>) => {
  try {
    postMessage({ jpeg: await render(event.data.bytes, event.data.crop) } satisfies RenderReply);
  } catch (error) {
    const invalid = error instanceof ToolError;
    const fix = invalid ? error.fix : undefined;
    postMessage({ message: error instanceof Error ? error.message : String(error), invalid, ...(fix ? { fix } : {}) } satisfies RenderReply);
  }
};
