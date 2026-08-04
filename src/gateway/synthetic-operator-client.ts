// Builds the in-process synthetic Gateway operator client used by trusted runtimes.
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

type SyntheticOperatorClientOptions = {
  agentRuntimeIdentity?: NonNullable<
    NonNullable<GatewayRequestOptions["client"]>["internal"]
  >["agentRuntimeIdentity"];
  allowModelOverride?: boolean;
  agentRunTracking?: "plugin_subagent";
  cronRunContinuation?: boolean;
  pluginRuntimeOwnerId?: string;
  scopes?: string[];
};

export function createSyntheticOperatorClient(
  params?: SyntheticOperatorClientOptions,
): GatewayRequestOptions["client"] {
  const pluginRuntimeOwnerId =
    typeof params?.pluginRuntimeOwnerId === "string" && params.pluginRuntimeOwnerId.trim()
      ? params.pluginRuntimeOwnerId.trim()
      : undefined;
  return {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "internal",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: params?.scopes ?? [WRITE_SCOPE],
    },
    internal: {
      allowModelOverride: params?.allowModelOverride === true,
      ...(params?.agentRunTracking ? { agentRunTracking: params.agentRunTracking } : {}),
      ...(params?.cronRunContinuation === true ? { cronRunContinuation: true } : {}),
      ...(params?.scopes?.includes(APPROVALS_SCOPE) ? { approvalRuntime: true } : {}),
      ...(params?.agentRuntimeIdentity
        ? { agentRuntimeIdentity: params.agentRuntimeIdentity }
        : {}),
      ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
    },
  };
}
