import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  revokeTrustedPresentationDeliveryCapability,
  type TrustedPresentationDeliveryCapability,
} from "./trusted-presentation-delivery-capability.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: ttsMocks.maybeApplyTtsToPayload,
}));

const slackConfig = {
  channels: { slack: { enabled: true } },
} as OpenClawConfig;

function registerPresentationPlugin(params: {
  sessionKey: string;
  threadId?: string;
  capture: (capability: TrustedPresentationDeliveryCapability | undefined) => void;
}) {
  const outboundRoute = {
    sessionKey: params.sessionKey,
    baseSessionKey: "agent:main:slack:channel:C123",
    recipientSessionExact: true as const,
    peer: { kind: "channel" as const, id: "C123" },
    chatType: "channel" as const,
    from: "slack:channel:C123",
    to: "channel:C123",
    ...(params.threadId ? { threadId: params.threadId } : {}),
  };
  const sendText = vi.fn().mockResolvedValue({
    channel: "slack",
    messageId: "m-presentation-1",
    chatId: "C123",
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              presentationCapabilities: { supported: true, divider: true },
              renderPresentation: ({ payload, deliveryCapability }) => {
                params.capture(deliveryCapability);
                return payload;
              },
              sendText,
            },
            messaging: {
              resolveOutboundSessionRoute: async () => outboundRoute,
            },
          }),
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
          ...(params.threadId
            ? {
                threading: {
                  threadAddressing: "message" as const,
                  resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs,
                },
              }
            : {}),
        },
      },
    ]),
  );
  return { outboundRoute, sendText };
}

describe("message action presentation delivery capability", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload.mockClear();
  });

  it("issues authority only for the exact complete requester route and revokes it", async () => {
    const sessionKey = "agent:main:slack:channel:C123:thread:source-thread";
    const requesterToolContext = {
      currentChannelProvider: "slack" as const,
      currentChannelId: "channel:C123",
      currentMessagingTarget: "channel:C123",
      currentGraphChannelId: "graph:C123",
      currentChatType: "channel" as const,
      currentThreadTs: "source-thread",
      currentSourceTurnId: "source-turn-1",
    };
    let capturedCapability: TrustedPresentationDeliveryCapability | undefined;
    const capture = (capability: TrustedPresentationDeliveryCapability | undefined) => {
      capturedCapability = capability;
    };
    const { sendText } = registerPresentationPlugin({
      sessionKey,
      threadId: "source-thread",
      capture,
    });
    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        accountId: "default",
        target: "channel:C123",
        message: "trusted presentation",
        presentation: { blocks: [{ type: "divider" }] },
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        requesterSenderId: "U123",
        toolContext: requesterToolContext,
      },
      toolContext: requesterToolContext,
      sessionKey,
      sessionId: "session-instance-1",
      agentId: "main",
      defaultAccountId: "default",
      dryRun: false,
    });

    expect(capturedCapability).toBeDefined();
    expect(revokeTrustedPresentationDeliveryCapability(capturedCapability)).toBe(false);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("does not issue authority when the originating route proof is incomplete", async () => {
    let capturedCapability: TrustedPresentationDeliveryCapability | undefined;
    const sessionKey = "agent:main:slack:channel:C123";
    registerPresentationPlugin({
      sessionKey,
      capture: (capability) => {
        capturedCapability = capability;
      },
    });

    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        accountId: "default",
        target: "channel:C123",
        message: "no source turn",
        presentation: { blocks: [{ type: "divider" }] },
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        requesterSenderId: "U123",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentMessagingTarget: "channel:C123",
          currentChatType: "channel",
        },
      },
      sessionKey,
      sessionId: "session-instance-1",
      agentId: "main",
      defaultAccountId: "default",
      dryRun: false,
    });

    expect(capturedCapability).toBeUndefined();
  });
});
