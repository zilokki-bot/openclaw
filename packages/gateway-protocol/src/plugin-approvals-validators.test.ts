import { describe, expect, it } from "vitest";
import { validatePluginApprovalRequestParams } from "./index.js";

describe("plugin approval protocol validators", () => {
  it("validates bounded reviewer-only detail independently from the description", () => {
    const request = {
      title: "Apply workspace skill proposal",
      description: "d".repeat(512),
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "full tool input" })).toBe(
      true,
    );
    expect(validatePluginApprovalRequestParams({ ...request, detail: "" })).toBe(false);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "x".repeat(16_385) })).toBe(
      false,
    );
    expect(validatePluginApprovalRequestParams({ ...request, description: "d".repeat(513) })).toBe(
      false,
    );
  });

  it("accepts only a closed approval-bound mutation request shape", () => {
    const request = {
      pluginId: "workboard",
      title: "Update Workboard card",
      description: "Apply one exact approved update.",
      approvalBoundMutation: {
        mutationId: "workboard-card-update:digest-a",
        resourceKind: "workboard-card",
        resourceId: "card-a",
        expectedRevision: 0,
      },
    };
    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(
      validatePluginApprovalRequestParams({
        ...request,
        approvalBoundMutation: { ...request.approvalBoundMutation, unexpected: true },
      }),
    ).toBe(false);
  });
});
