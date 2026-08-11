import { describe, expect, it } from "vitest";
import { rejectUnapprovedMaintenanceApply } from "./maintenance-apply-gate.js";

describe("maintenance apply gate", () => {
  it("keeps dry-run available and refuses a local --apply without a Gateway approval action", () => {
    expect(() => rejectUnapprovedMaintenanceApply(false)).not.toThrow();
    expect(() => rejectUnapprovedMaintenanceApply(undefined)).not.toThrow();
    expect(() => rejectUnapprovedMaintenanceApply(true)).toThrow(
      "no public operator-approved maintenance action",
    );
  });
});
