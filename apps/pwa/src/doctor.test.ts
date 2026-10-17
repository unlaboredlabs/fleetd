import { DoctorCheck } from "@fleetd/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { doctorOrder, doctorTitle, withFixed } from "./doctor.ts";

const check = (id: string, status: string): DoctorCheck =>
  Schema.decodeUnknownSync(DoctorCheck)({ id, scope: id.startsWith("hub/") ? "hub" : "machine", ...(id.startsWith("hub/") ? {} : { machineId: id.split("/")[0] }), status, message: id });

describe("doctor", () => {
  const checks = [check("hub/gh_auth", "ok"), check("lab-a/disk", "warn"), check("lab-a/probes", "unknown"), check("lab-a/online", "fail"), check("lab-b/online", "fail")];

  it("puts failures first, keeping the hub's order within a status", () => {
    expect(doctorOrder(checks).map((c) => c.id)).toEqual(["lab-a/online", "lab-b/online", "lab-a/disk", "lab-a/probes", "hub/gh_auth"]);
  });

  it("counts what needs attention, or says all pass", () => {
    expect(doctorTitle(undefined)).toBe("Doctor");
    expect(doctorTitle(checks)).toBe("Doctor: 3 need attention");
    expect(doctorTitle([check("lab-a/disk", "warn")])).toBe("Doctor: 1 needs attention");
    expect(doctorTitle([check("hub/gh_auth", "ok"), check("lab-a/probes", "unknown")])).toBe("Doctor: 1 pass, 1 not checked");
    expect(doctorTitle([check("hub/gh_auth", "ok")])).toBe("Doctor: all 1 checks pass");
  });

  it("puts a fixed check's new result in place", () => {
    expect(withFixed(checks, check("lab-a/online", "ok")).map((c) => c.status)).toEqual(["ok", "warn", "unknown", "ok", "fail"]);
  });
});
