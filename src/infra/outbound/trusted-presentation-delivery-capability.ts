import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stableStringify } from "../../agents/stable-stringify.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import {
  normalizeAccountId,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import type { OutboundSessionRoute } from "./outbound-session.js";

const APPROVAL_TTL_MS = 10 * 60_000;

declare const trustedPresentationDeliveryCapabilityBrand: unique symbol;

/**
 * Process-local authority for one structured-presentation delivery.
 *
 * The value has no enumerable state and is valid only while its issuing message
 * action is active. Channel plugins may forward it to a trusted core API, but
 * cannot reconstruct it from route fields or a serialized copy.
 */
export type TrustedPresentationDeliveryCapability = Readonly<{
  [trustedPresentationDeliveryCapabilityBrand]: true;
}>;

type TrustedRequesterRoute = {
  channel: ChannelId;
  accountId: string;
  channelId: string;
  messagingTarget: string;
  graphChannelId?: string;
  chatType: ChatType;
  threadId?: string;
  sourceTurnId: string;
};

type TrustedDestinationRoute = {
  channel: ChannelId;
  accountId: string;
  to: string;
  threadId?: string;
  sessionKey: string;
  baseSessionKey: string;
  routeFrom: string;
  routeTo: string;
  routeThreadId?: string;
  chatType: OutboundSessionRoute["chatType"];
  recipientSessionExact: NonNullable<OutboundSessionRoute["recipientSessionExact"]>;
};

export type TrustedPresentationDeliveryScope = {
  planHash: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  requesterAccountId: string;
  requesterSenderId: string;
  requesterRoute: TrustedRequesterRoute;
  destinationRoute: TrustedDestinationRoute;
};

type StoredCapability = TrustedPresentationDeliveryScope & {
  expiresAtMs: number;
  renewed: boolean;
};

const capabilities = new WeakMap<object, StoredCapability>();

function normalizeRequired(value: string | null | undefined): string | undefined {
  return normalizeOptionalString(value);
}

function normalizeThreadId(value: string | number | null | undefined): string | undefined {
  return value == null ? undefined : normalizeOptionalString(String(value));
}

function resolveTtlMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return APPROVAL_TTL_MS;
  }
  return Math.min(Math.trunc(value), APPROVAL_TTL_MS);
}

function normalizeRequesterRoute(params: {
  channel: ChannelId;
  accountId?: string | null;
  toolContext?: InternalChannelThreadingToolContext;
}): TrustedRequesterRoute | undefined {
  const toolContext = params.toolContext;
  const channel = normalizeRequired(toolContext?.currentChannelProvider);
  const accountId = normalizeRequired(params.accountId);
  const channelId = normalizeRequired(toolContext?.currentChannelId);
  const messagingTarget = normalizeRequired(toolContext?.currentMessagingTarget) ?? channelId;
  const sourceTurnId = normalizeRequired(toolContext?.currentSourceTurnId);
  const chatType = toolContext?.currentChatType;
  if (
    channel !== params.channel ||
    !accountId ||
    !channelId ||
    !messagingTarget ||
    !sourceTurnId ||
    !chatType
  ) {
    return undefined;
  }
  return {
    channel: params.channel,
    accountId: normalizeAccountId(accountId),
    channelId,
    messagingTarget,
    graphChannelId: normalizeRequired(toolContext?.currentGraphChannelId),
    chatType,
    threadId: normalizeRequired(toolContext?.currentThreadTs),
    sourceTurnId,
  };
}

function normalizeDestinationRoute(params: {
  channel: ChannelId;
  accountId?: string | null;
  to: string;
  threadId?: string | number | null;
  outboundRoute: OutboundSessionRoute;
}): TrustedDestinationRoute | undefined {
  const accountId = normalizeRequired(params.accountId);
  const to = normalizeRequired(params.to);
  const sessionKey = normalizeRequired(params.outboundRoute.sessionKey);
  const baseSessionKey = normalizeRequired(params.outboundRoute.baseSessionKey);
  const routeFrom = normalizeRequired(params.outboundRoute.from);
  const routeTo = normalizeRequired(params.outboundRoute.to);
  const recipientSessionExact = params.outboundRoute.recipientSessionExact;
  if (
    !accountId ||
    !to ||
    !sessionKey ||
    !baseSessionKey ||
    !routeFrom ||
    !routeTo ||
    recipientSessionExact === undefined
  ) {
    return undefined;
  }
  return {
    channel: params.channel,
    accountId: normalizeAccountId(accountId),
    to,
    threadId: normalizeThreadId(params.threadId),
    sessionKey,
    baseSessionKey,
    routeFrom,
    routeTo,
    routeThreadId: normalizeThreadId(params.outboundRoute.threadId),
    chatType: params.outboundRoute.chatType,
    recipientSessionExact,
  };
}

export function resolveTrustedPresentationDeliveryScope(params: {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  requesterToolContext?: InternalChannelThreadingToolContext;
  channel: ChannelId;
  accountId?: string | null;
  to: string;
  threadId?: string | number | null;
  outboundRoute: OutboundSessionRoute;
  presentationPlan: unknown;
}): TrustedPresentationDeliveryScope | undefined {
  const agentId = normalizeRequired(params.agentId);
  const sessionKey = normalizeRequired(params.sessionKey);
  const sessionId = normalizeRequired(params.sessionId);
  const requesterAccountId = normalizeRequired(params.requesterAccountId);
  const requesterSenderId = normalizeRequired(params.requesterSenderId);
  const requesterRoute = normalizeRequesterRoute({
    channel: params.channel,
    accountId: params.requesterAccountId,
    toolContext: params.requesterToolContext,
  });
  const destinationRoute = normalizeDestinationRoute({
    channel: params.channel,
    accountId: params.accountId,
    to: params.to,
    threadId: params.threadId,
    outboundRoute: params.outboundRoute,
  });
  if (
    !agentId ||
    !sessionKey ||
    !sessionId ||
    !requesterAccountId ||
    !requesterSenderId ||
    !requesterRoute ||
    !destinationRoute ||
    normalizeAccountId(requesterAccountId) !== requesterRoute.accountId ||
    requesterRoute.accountId !== destinationRoute.accountId ||
    sessionKey !== destinationRoute.sessionKey ||
    normalizeAgentId(agentId) !== normalizeAgentId(resolveAgentIdFromSessionKey(sessionKey))
  ) {
    return undefined;
  }
  const scopeWithoutPlanHash = {
    agentId: normalizeAgentId(agentId),
    sessionKey,
    sessionId,
    requesterAccountId: normalizeAccountId(requesterAccountId),
    requesterSenderId,
    requesterRoute,
    destinationRoute,
  };
  return {
    planHash: `sha256:${createHash("sha256")
      .update(
        stableStringify({
          ...scopeWithoutPlanHash,
          presentationPlan: params.presentationPlan,
        }),
      )
      .digest("hex")}`,
    ...scopeWithoutPlanHash,
  };
}

function stableScope(scope: TrustedPresentationDeliveryScope): string {
  return stableStringify(scope);
}

/** @internal Issuance is deliberately absent from the plugin SDK. */
export function issueTrustedPresentationDeliveryCapability(params: {
  scope: TrustedPresentationDeliveryScope;
  ttlMs?: number;
  nowMs?: number;
}): TrustedPresentationDeliveryCapability {
  const capability = Object.freeze(Object.create(null)) as TrustedPresentationDeliveryCapability;
  const nowMs = params.nowMs ?? Date.now();
  capabilities.set(capability, {
    ...params.scope,
    expiresAtMs: nowMs + resolveTtlMs(params.ttlMs),
    renewed: false,
  });
  return capability;
}

/** @internal Core verification always supplies its own trusted expected scope. */
export function isTrustedPresentationDeliveryCapabilityValid(params: {
  capability?: TrustedPresentationDeliveryCapability;
  expected: TrustedPresentationDeliveryScope;
  nowMs?: number;
}): boolean {
  if (!params.capability || typeof params.capability !== "object") {
    return false;
  }
  const stored = capabilities.get(params.capability);
  if (!stored) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  if (nowMs >= stored.expiresAtMs) {
    capabilities.delete(params.capability);
    return false;
  }
  const { expiresAtMs: _expiresAtMs, renewed: _renewed, ...scope } = stored;
  return stableScope(scope) === stableScope(params.expected);
}

/** @internal Grants at most one same-plan extension while the original grant is active. */
export function renewTrustedPresentationDeliveryCapability(params: {
  capability?: TrustedPresentationDeliveryCapability;
  planHash: string;
  nowMs?: number;
  ttlMs?: number;
}): boolean {
  if (!params.capability || typeof params.capability !== "object") {
    return false;
  }
  const stored = capabilities.get(params.capability);
  if (!stored) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  if (
    nowMs >= stored.expiresAtMs ||
    stored.renewed ||
    normalizeRequired(params.planHash) !== stored.planHash
  ) {
    if (nowMs >= stored.expiresAtMs) {
      capabilities.delete(params.capability);
    }
    return false;
  }
  stored.expiresAtMs = nowMs + resolveTtlMs(params.ttlMs);
  stored.renewed = true;
  return true;
}

/** Invalidates a capability when its trusted plugin/channel turn exits. */
export function revokeTrustedPresentationDeliveryCapability(
  capability: TrustedPresentationDeliveryCapability | undefined,
): boolean {
  return capability ? capabilities.delete(capability) : false;
}
