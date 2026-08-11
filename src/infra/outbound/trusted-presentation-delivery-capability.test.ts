import { describe, expect, it } from "vitest";
import {
  isTrustedPresentationDeliveryCapabilityValid,
  issueTrustedPresentationDeliveryCapability,
  renewTrustedPresentationDeliveryCapability,
  resolveTrustedPresentationDeliveryScope,
  revokeTrustedPresentationDeliveryCapability,
  type TrustedPresentationDeliveryCapability,
  type TrustedPresentationDeliveryScope,
} from "./trusted-presentation-delivery-capability.js";

function createScope(
  presentationPlan: unknown = { blocks: [{ type: "divider" }] },
): TrustedPresentationDeliveryScope {
  const scope = resolveTrustedPresentationDeliveryScope({
    agentId: "main",
    sessionKey: "agent:main:slack:channel:C123:thread:source-thread",
    sessionId: "session-instance-1",
    requesterAccountId: "default",
    requesterSenderId: "U123",
    requesterToolContext: {
      currentChannelProvider: "slack",
      currentChannelId: "channel:C123",
      currentMessagingTarget: "channel:C123",
      currentGraphChannelId: "graph:C123",
      currentChatType: "channel",
      currentThreadTs: "source-thread",
      currentSourceTurnId: "channel-user:v1:source-1",
    },
    channel: "slack",
    accountId: "default",
    to: "channel:C123",
    threadId: "source-thread",
    outboundRoute: {
      sessionKey: "agent:main:slack:channel:C123:thread:source-thread",
      baseSessionKey: "agent:main:slack:channel:C123",
      recipientSessionExact: true,
      peer: { kind: "channel", id: "C123" },
      chatType: "channel",
      from: "slack:channel:C123",
      to: "channel:C123",
      threadId: "source-thread",
    },
    presentationPlan,
  });
  if (!scope) {
    throw new Error("expected complete trusted presentation route scope");
  }
  return scope;
}

function replaceScope(
  scope: TrustedPresentationDeliveryScope,
  patch: Partial<TrustedPresentationDeliveryScope>,
): TrustedPresentationDeliveryScope {
  return { ...scope, ...patch };
}

describe("trusted presentation delivery capability", () => {
  it("is process-local, opaque, and cannot be forged or serialized", () => {
    const scope = createScope();
    const capability = issueTrustedPresentationDeliveryCapability({ scope, nowMs: 1000 });

    expect(Object.keys(capability)).toEqual([]);
    expect(JSON.stringify(capability)).toBe("{}");
    const cloned = structuredClone(capability) as TrustedPresentationDeliveryCapability;
    expect(
      isTrustedPresentationDeliveryCapabilityValid({ capability, expected: scope, nowMs: 2000 }),
    ).toBe(true);
    expect(
      isTrustedPresentationDeliveryCapabilityValid({
        capability: {} as TrustedPresentationDeliveryCapability,
        expected: scope,
        nowMs: 2000,
      }),
    ).toBe(false);
    expect(
      isTrustedPresentationDeliveryCapabilityValid({
        capability: cloned,
        expected: scope,
        nowMs: 2000,
      }),
    ).toBe(false);
  });

  it("rejects foreign agent, account, topic, route, and session identities", () => {
    const scope = createScope();
    expect(createScope().planHash).toBe(scope.planHash);
    expect(createScope({ blocks: [{ type: "text", text: "changed" }] }).planHash).not.toBe(
      scope.planHash,
    );
    const capability = issueTrustedPresentationDeliveryCapability({ scope, nowMs: 1000 });
    const mismatches: TrustedPresentationDeliveryScope[] = [
      replaceScope(scope, { planHash: "sha256:foreign-plan" }),
      replaceScope(scope, { agentId: "other" }),
      replaceScope(scope, { sessionKey: "agent:main:slack:channel:C999" }),
      replaceScope(scope, { sessionId: "session-instance-2" }),
      replaceScope(scope, { requesterAccountId: "other" }),
      replaceScope(scope, { requesterSenderId: "U999" }),
      replaceScope(scope, {
        requesterRoute: { ...scope.requesterRoute, channel: "discord" },
      }),
      replaceScope(scope, {
        requesterRoute: { ...scope.requesterRoute, accountId: "other" },
      }),
      replaceScope(scope, {
        requesterRoute: { ...scope.requesterRoute, channelId: "channel:C999" },
      }),
      replaceScope(scope, {
        requesterRoute: { ...scope.requesterRoute, threadId: "other-thread" },
      }),
      replaceScope(scope, {
        requesterRoute: { ...scope.requesterRoute, sourceTurnId: "channel-user:v1:source-2" },
      }),
      replaceScope(scope, {
        destinationRoute: { ...scope.destinationRoute, accountId: "other" },
      }),
      replaceScope(scope, {
        destinationRoute: { ...scope.destinationRoute, to: "channel:C999" },
      }),
      replaceScope(scope, {
        destinationRoute: { ...scope.destinationRoute, threadId: "other-thread" },
      }),
      replaceScope(scope, {
        destinationRoute: {
          ...scope.destinationRoute,
          sessionKey: "agent:main:slack:channel:C999",
        },
      }),
    ];

    for (const expected of mismatches) {
      expect(
        isTrustedPresentationDeliveryCapabilityValid({
          capability,
          expected,
          nowMs: 2000,
        }),
      ).toBe(false);
    }
  });

  it("expires, allows one same-plan renewal, and invalidates at turn exit", () => {
    const scope = createScope();
    const expired = issueTrustedPresentationDeliveryCapability({
      scope,
      nowMs: 1000,
      ttlMs: 1000,
    });
    expect(
      isTrustedPresentationDeliveryCapabilityValid({
        capability: expired,
        expected: scope,
        nowMs: 2000,
      }),
    ).toBe(false);

    const renewable = issueTrustedPresentationDeliveryCapability({
      scope,
      nowMs: 1000,
      ttlMs: 1000,
    });
    expect(
      renewTrustedPresentationDeliveryCapability({
        capability: renewable,
        planHash: "sha256:foreign-plan",
        nowMs: 1500,
        ttlMs: 1000,
      }),
    ).toBe(false);
    expect(
      renewTrustedPresentationDeliveryCapability({
        capability: renewable,
        planHash: scope.planHash,
        nowMs: 1500,
        ttlMs: 1000,
      }),
    ).toBe(true);
    expect(
      renewTrustedPresentationDeliveryCapability({
        capability: renewable,
        planHash: scope.planHash,
        nowMs: 1600,
        ttlMs: 1000,
      }),
    ).toBe(false);
    expect(
      isTrustedPresentationDeliveryCapabilityValid({
        capability: renewable,
        expected: scope,
        nowMs: 2400,
      }),
    ).toBe(true);
    expect(
      isTrustedPresentationDeliveryCapabilityValid({
        capability: renewable,
        expected: scope,
        nowMs: 2500,
      }),
    ).toBe(false);

    const revoked = issueTrustedPresentationDeliveryCapability({ scope, nowMs: 1000 });
    expect(revokeTrustedPresentationDeliveryCapability(revoked)).toBe(true);
    expect(
      isTrustedPresentationDeliveryCapabilityValid({
        capability: revoked,
        expected: scope,
        nowMs: 2000,
      }),
    ).toBe(false);
  });

  it("fails closed when any originating route or session proof is missing", () => {
    const base = {
      agentId: "main",
      sessionKey: "agent:main:slack:channel:C123",
      sessionId: "session-instance-1",
      requesterAccountId: "default",
      requesterSenderId: "U123",
      requesterToolContext: {
        currentChannelProvider: "slack" as const,
        currentChannelId: "channel:C123",
        currentMessagingTarget: "channel:C123",
        currentChatType: "channel" as const,
        currentSourceTurnId: "source-turn-1",
      },
      channel: "slack" as const,
      accountId: "default",
      to: "channel:C123",
      outboundRoute: {
        sessionKey: "agent:main:slack:channel:C123",
        baseSessionKey: "agent:main:slack:channel:C123",
        recipientSessionExact: true as const,
        peer: { kind: "channel" as const, id: "C123" },
        chatType: "channel" as const,
        from: "slack:channel:C123",
        to: "channel:C123",
      },
      presentationPlan: { blocks: [{ type: "divider" }] },
    };

    expect(resolveTrustedPresentationDeliveryScope(base)).toBeDefined();
    expect(
      resolveTrustedPresentationDeliveryScope({ ...base, sessionId: undefined }),
    ).toBeUndefined();
    expect(
      resolveTrustedPresentationDeliveryScope({ ...base, requesterAccountId: undefined }),
    ).toBeUndefined();
    expect(
      resolveTrustedPresentationDeliveryScope({ ...base, requesterSenderId: undefined }),
    ).toBeUndefined();
    expect(
      resolveTrustedPresentationDeliveryScope({
        ...base,
        requesterToolContext: { ...base.requesterToolContext, currentSourceTurnId: undefined },
      }),
    ).toBeUndefined();
    expect(
      resolveTrustedPresentationDeliveryScope({
        ...base,
        requesterToolContext: {
          ...base.requesterToolContext,
          currentChannelId: undefined,
          currentMessagingTarget: undefined,
        },
      }),
    ).toBeUndefined();
  });
});
