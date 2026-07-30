import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markUsageOnlySourceReplyFooterForDelivery } from "./source-reply-usage-footer.js";

describe("markUsageOnlySourceReplyFooterForDelivery", () => {
  it("marks usage-only source-reply footer for delivery under message_tool_only", () => {
    const [payload] = markUsageOnlySourceReplyFooterForDelivery({
      finalPayloads: [{ text: "Usage: 12 in / 3 out" }],
      responseUsageLine: "Usage: 12 in / 3 out",
      completedSourceReplyDelivery: true,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(payload).toEqual({ text: "Usage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(payload ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("does not mark ordinary final text that is not the usage-only footer", () => {
    const [payload] = markUsageOnlySourceReplyFooterForDelivery({
      finalPayloads: [{ text: "reply\nUsage: 12 in / 3 out" }],
      responseUsageLine: "Usage: 12 in / 3 out",
      completedSourceReplyDelivery: true,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(getReplyPayloadMetadata(payload ?? {})).toBeUndefined();
  });
});
