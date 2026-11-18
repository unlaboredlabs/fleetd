import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { systemCAs } from "./trust";

describe("system CAs", () => {
  it("trusts the OS's store, read on a worker", async () => {
    await systemCAs();
    const trusted = new Set(tls.getCACertificates("default"));
    for (const cert of tls.getCACertificates("system")) expect(trusted.has(cert)).toBe(true);
    // Read once: asked again, it is already done.
    await expect(systemCAs()).resolves.toBeUndefined();
  });
});
