import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

export function markUsageOnlySourceReplyFooterForDelivery(params: {
  finalPayloads: ReplyPayload[];
  responseUsageLine: string | undefined;
  completedSourceReplyDelivery: boolean;
  sourceReplyDeliveryMode: string | undefined;
}): ReplyPayload[] {
  const {
    completedSourceReplyDelivery,
    finalPayloads,
    responseUsageLine,
    sourceReplyDeliveryMode,
  } = params;
  if (
    responseUsageLine &&
    completedSourceReplyDelivery &&
    sourceReplyDeliveryMode === "message_tool_only" &&
    finalPayloads.length === 1 &&
    finalPayloads[0]?.text === responseUsageLine
  ) {
    return [markReplyPayloadForSourceSuppressionDelivery(finalPayloads[0])];
  }
  return finalPayloads;
}
