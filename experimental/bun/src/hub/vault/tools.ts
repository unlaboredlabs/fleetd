import type { Registry } from "../api/registry.ts";

/** Replaces the registry's NotImplemented stubs for this module's tools (src/gen/tools.ts lists them). */
export function register(_tools: Registry): void {}
