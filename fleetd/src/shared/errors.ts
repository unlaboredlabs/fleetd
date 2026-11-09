import type { ErrorCode, ErrorReason } from "./contracts.ts";

/** Something fleetd doesn't do yet. Its message names the module that would. */
export class NotImplemented extends Error {
  constructor(readonly module: string) {
    super(`fleetd doesn't do this yet: ${module}`);
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
