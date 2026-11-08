import type { ErrorCode, ErrorReason } from "./contracts.ts";

/** A part of the port that isn't written yet. Its message names the Bun module that will do it (PORT_MAP.md). */
export class NotImplemented extends Error {
  constructor(readonly module: string) {
    super(`not ported to Bun yet: ${module} (experimental/bun/PORT_MAP.md)`);
    this.name = "NotImplemented";
  }
}

/** A tool failure in the contracts' McpToolError shape, `{ code, message, fix?, reason? }`. */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fix?: string,
    readonly reason?: ErrorReason,
    /** What a person does next where `fix` is worded for an agent; sent as `fix` to a person's device. */
    readonly personFix?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }

  /** The error as a person's device gets it: `personFix` in place of `fix` where there is one. */
  forPerson(): ToolError {
    return this.personFix === undefined ? this : new ToolError(this.code, this.message, this.personFix, this.reason);
  }

  toJSON(): { code: ErrorCode; message: string; fix?: string; reason?: ErrorReason } {
    return {
      code: this.code,
      message: this.message,
      ...(this.fix === undefined ? {} : { fix: this.fix }),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }
}

/** Store failures and crashes: logged, and answered with this. */
export const internalError = () =>
  new ToolError("failed", "The hub failed to answer that request.", "Retry; if it keeps failing, check the hub log.");
